"""Transport-independent, bounded, bidirectional JSON-RPC connection."""
from __future__ import annotations

import asyncio
import json
import re
import uuid
from typing import Any

from .ui import UI_COMMANDS, View, counter_document, form_document, safe_text

MAX_FRAME = 1024 * 1024
MAX_PENDING = 32
QUEUE_SIZE = 32
IO_TIMEOUT = 5
CALL_TIMEOUT = 30
HOOKS = ["session_start", "before_agent_start", "tool_call"]
CATALOG = {
    "protocolVersion": "0.1",
    "name": "demo",
    "tools": [
        {"name": "greet", "description": "Greet a person", "parameters": {
            "type": "object", "properties": {"name": {"type": "string", "maxLength": 100}},
            "required": ["name"], "additionalProperties": False}},
        {"name": "wait", "description": "Wait with progress and cancellation", "parameters": {
            "type": "object", "properties": {"milliseconds": {
                "type": "integer", "minimum": 0, "maximum": 10000}},
            "required": ["milliseconds"], "additionalProperties": False}},
    ],
    "commands": [{"name": "hello", "description": "Show a greeting"}],
    "hooks": HOOKS,
}


class ProtocolError(Exception):
    """Fatal framing/envelope error. Never include untrusted data in diagnostics."""


class RPCError(Exception):
    def __init__(self, code: int, message: str):
        self.code, self.message = code, message
        super().__init__(message)


def decode(raw: bytes | str) -> dict[str, Any]:
    try:
        if len(raw if isinstance(raw, bytes) else raw.encode("utf-8")) > MAX_FRAME:
            raise ProtocolError("Frame too large")
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        value = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise ProtocolError("Invalid JSON") from exc
    if not isinstance(value, dict):
        raise ProtocolError("Envelope must be an object")
    return value


def encode(message: dict[str, Any]) -> str:
    try:
        raw = json.dumps(message, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
        if len(raw.encode("utf-8")) > MAX_FRAME:
            raise ProtocolError("Frame too large")
        return raw
    except (ValueError, RecursionError) as exc:
        raise ProtocolError("Invalid JSON") from exc


def require(condition: bool, message: str = "Invalid params") -> None:
    if not condition:
        raise RPCError(-32602, message)


def shape(value: Any, required: set[str], optional: set[str] | None = None) -> None:
    require(isinstance(value, dict))
    require(required <= value.keys() <= required | (optional or set()))


def context(value: Any) -> None:
    shape(value, {"cwd"})
    require(isinstance(value["cwd"], str))


def valid_id(value: Any, prefix: str) -> bool:
    return isinstance(value, str) and 1 <= len(value) <= 128 and value.startswith(prefix)


class Connection:
    def __init__(self) -> None:
        self.outgoing: asyncio.Queue[str | None] = asyncio.Queue(QUEUE_SIZE)
        self.requests: dict[str, asyncio.Task] = {}
        self.tasks: set[asyncio.Task] = set()
        self.started: set[str] = set()
        self.cancelled: set[str] = set()
        self.reverse: dict[str, tuple[str, asyncio.Future]] = {}
        self.permissions: set[str] = set()
        self.ui_timeout: float | None = None
        self.views: dict[str, View] = {}
        self.initialized = False
        self.closing = False
        self.closed = asyncio.Event()
        self.counter = 0

    async def send(self, message: dict[str, Any]) -> None:
        if self.closing:
            raise ProtocolError("Connection closed")
        raw = encode(message)
        try:
            await asyncio.wait_for(self.outgoing.put(raw), IO_TIMEOUT)
        except TimeoutError as exc:
            raise ProtocolError("Slow consumer") from exc

    async def accept(self, message: dict[str, Any]) -> None:
        if self.closing:
            raise ProtocolError("Connection closed")
        if message.get("jsonrpc") != "2.0":
            raise ProtocolError("Invalid envelope")
        if "method" not in message:
            await self._response(message)
            return
        if not message.keys() <= {"jsonrpc", "id", "method", "params"}:
            raise ProtocolError("Invalid request envelope")
        if not isinstance(message["method"], str) or not message["method"]:
            raise ProtocolError("Invalid method")
        request_id = message.get("id")
        if "id" in message and not valid_id(request_id, "pi-"):
            raise ProtocolError("Invalid host request ID")
        if message["method"] == "$/cancelRequest" and "id" not in message:
            params = message.get("params")
            if isinstance(params, dict) and set(params) == {"id"} and valid_id(params["id"], "pi-"):
                task = self.requests.get(params["id"])
                if task and params["id"] not in self.cancelled:
                    self.cancelled.add(params["id"])
                    if params["id"] in self.started:
                        task.cancel()
            return
        if request_id in self.requests:
            raise ProtocolError("Duplicate live request ID")
        if len(self.tasks) >= MAX_PENDING:
            if request_id is not None:
                await self.send({"jsonrpc": "2.0", "id": request_id,
                                 "error": {"code": -32000, "message": "Too many pending requests"}})
            return
        task = asyncio.create_task(self._run(request_id, message["method"], message.get("params")))
        self.tasks.add(task)
        if request_id is not None:
            self.requests[request_id] = task
        task.add_done_callback(self.tasks.discard)

    async def _response(self, message: dict[str, Any]) -> None:
        if (not message.keys() <= {"jsonrpc", "id", "result", "error"}
                or not valid_id(message.get("id"), "ext-")
                or ("result" in message) == ("error" in message)):
            raise ProtocolError("Invalid response")
        if "error" in message:
            error = message["error"]
            if (not isinstance(error, dict) or type(error.get("code")) is not int
                    or not isinstance(error.get("message"), str)):
                raise ProtocolError("Invalid error")
        entry = self.reverse.get(message["id"])
        if entry and not entry[1].done():
            if "error" in message:
                entry[1].set_exception(RPCError(-32000, "Host UI request failed"))
            else:
                entry[1].set_result(message["result"])

    async def _run(self, request_id: str | None, method: str, params: Any) -> None:
        shutdown = False
        if request_id is not None:
            self.started.add(request_id)
        try:
            try:
                if request_id in self.cancelled:
                    raise asyncio.CancelledError
                if method == "command.execute" and self.ui_timeout is not None:
                    async with asyncio.timeout(self.ui_timeout):
                        result = await self.dispatch(request_id, method, params)
                else:
                    result = await self.dispatch(request_id, method, params)
                response = {"result": result}
                shutdown = method == "shutdown"
            except asyncio.CancelledError:
                if self.closing:
                    return
                response = {"error": {"code": -32800, "message": "Request cancelled"}}
            except RPCError as exc:
                response = {"error": {"code": exc.code, "message": exc.message}}
            except Exception:
                response = {"error": {"code": -32000, "message": "Operation failed"}}
            # Settlement wins cancellation once the terminal response is decided.
            # Retire before the writer can suspend, so a late cancel cannot close
            # the connection or cancel a different request.
            self._retire(request_id)
            if request_id is not None:
                await self.send({"jsonrpc": "2.0", "id": request_id, **response})
            if shutdown:
                await self.close(graceful=True)
        except (ProtocolError, asyncio.CancelledError):
            if not self.closing:
                await self.close()
        finally:
            self._retire(request_id)

    def _retire(self, request_id: str | None) -> None:
        if request_id is not None:
            self.requests.pop(request_id, None)
            self.started.discard(request_id)
            self.cancelled.discard(request_id)
            for reverse_id, (parent, future) in list(self.reverse.items()):
                if parent == request_id:
                    future.cancel()
                    self.reverse.pop(reverse_id, None)

    async def host_call(self, parent: str | None, method: str, params: dict) -> Any:
        if parent is None or parent not in self.requests:
            raise RPCError(-32000, "A live parent request is required")
        custom = method in {"host.ui.open", "host.ui.update", "host.ui.close"}
        permission = "ui.custom" if custom else method.removeprefix("host.")
        if permission not in self.permissions or (custom and self.ui_timeout is None):
            raise RPCError(-32000, "Required UI permission is missing")
        if custom:
            view = self.views.get(params.get("viewId"))
            if view is None or view.parent != parent or parent in self.cancelled:
                raise RPCError(-32001, "UI parent is no longer active")
        self.counter += 1
        request_id = f"ext-{self.counter}"
        future = asyncio.get_running_loop().create_future()
        self.reverse[request_id] = (parent, future)
        if method == "host.ui.open":
            view.open_request_id = request_id
        timeout = self.ui_timeout if method == "host.ui.open" else CALL_TIMEOUT
        try:
            await self.send({"jsonrpc": "2.0", "id": request_id, "method": method,
                             "params": {"parentRequestId": parent, **params}})
            try:
                return await asyncio.wait_for(future, timeout)
            except TimeoutError as exc:
                raise RPCError(-32000, "Host UI request timed out") from exc
        finally:
            self.reverse.pop(request_id, None)
            future.cancel()

    async def dispatch(self, request_id: str | None, method: str, params: Any) -> dict:
        if method == "shutdown":
            shape(params, set())
            return {}
        if method == "initialize":
            shape(params, {"protocolVersion", "client", "permissions", "context"},
                  {"optionalFeatures", "ui"})
            require(params["protocolVersion"] == "0.1", "Unsupported protocol version")
            shape(params["client"], {"name", "version"})
            require(all(isinstance(v, str) for v in params["client"].values()))
            require(isinstance(params["permissions"], list)
                    and all(isinstance(v, str) for v in params["permissions"]))
            context(params["context"])
            if self.initialized:
                raise RPCError(-32000, "Already initialized")
            permissions = set(params["permissions"])
            offered = params.get("optionalFeatures", [])
            require(isinstance(offered, list) and all(isinstance(v, str) for v in offered))
            require(len(set(offered)) == len(offered))
            if "optionalFeatures" in params or "ui" in params:
                require("ui.custom" in permissions)
            ui_timeout = None
            if "ui" in params:
                shape(params["ui"], {"timeoutMs"})
                timeout = params["ui"]["timeoutMs"]
                require(type(timeout) is int and 1000 <= timeout <= 900000)
            if "tui_v1" in offered:
                require("ui" in params)
                ui_timeout = params["ui"]["timeoutMs"] / 1000
            self.permissions = permissions & {"ui.confirm", "ui.notify", "ui.custom"}
            self.ui_timeout = ui_timeout
            self.initialized = True
            if ui_timeout is not None:
                return {**CATALOG, "features": ["tui_v1"],
                        "commands": [*CATALOG["commands"], *UI_COMMANDS]}
            return CATALOG
        if method not in {"tool.call", "command.execute", "hook.run", "ui.event"}:
            raise RPCError(-32601, "Method not found")
        if not self.initialized:
            raise RPCError(-32000, "Initialize first")
        if method == "ui.event":
            require(request_id is not None, "UI events must be requests")
            return await self.ui_event(params)
        if method == "hook.run":
            shape(params, {"name", "event", "context"})
            context(params["context"])
            require(isinstance(params["name"], str) and params["name"] in HOOKS)
            event = params["event"]
            if params["name"] == "session_start":
                shape(event, {"reason"})
                require(isinstance(event["reason"], str))
            elif params["name"] == "before_agent_start":
                shape(event, {"prompt", "systemPrompt"})
                require(all(isinstance(v, str) for v in event.values()))
            else:
                shape(event, {"toolName", "toolCallId", "input"})
                require(isinstance(event["toolName"], str) and isinstance(event["toolCallId"], str))
                require(isinstance(event["input"], dict))
            return {}  # Deliberately no prompt mutation and no tool veto.
        shape(params, {"name", "arguments", "context"})
        context(params["context"])
        require(isinstance(params["name"], str))
        name, args = params["name"], params["arguments"]
        if method == "command.execute":
            require(isinstance(args, str))
            if name in {"ui_form", "ui_counter"} and self.ui_timeout is not None:
                return await self.ui_command(request_id, name)
            require(name == "hello")
            return {"text": f"Hello, {args or 'world'}!"}
        if name == "greet":
            shape(args, {"name"})
            require(isinstance(args["name"], str) and len(args["name"]) <= 100)
            # Check both permissions before starting any UI work.
            if not {"ui.confirm", "ui.notify"} <= self.permissions:
                raise RPCError(-32000, "Required UI permission is missing")
            confirmed = await self.host_call(request_id, "host.ui.confirm", {
                "title": "Greeting", "message": f"Greet {args['name']}?"})
            if not isinstance(confirmed, dict) or type(confirmed.get("confirmed")) is not bool:
                raise RPCError(-32000, "Invalid confirmation response")
            if not confirmed["confirmed"]:
                raise RPCError(-32000, "Greeting was not confirmed")
            greeting = f"Hello, {args['name']}!"
            notified = await self.host_call(request_id, "host.ui.notify", {
                "message": greeting, "level": "info"})
            if notified != {}:
                raise RPCError(-32000, "Invalid notification response")
            return {"content": [{"type": "text", "text": greeting}], "details": {}}
        if name == "wait":
            shape(args, {"milliseconds"})
            require(type(args["milliseconds"]) is int and 0 <= args["milliseconds"] <= 10000)
            remaining = args["milliseconds"] / 1000
            while True:
                if request_id is not None:
                    await self.send({"jsonrpc": "2.0", "method": "progress", "params": {
                        "requestId": request_id, "content": [{"type": "text", "text": "Waiting…"}]}})
                if remaining <= 0:
                    break
                interval = min(0.25, remaining)
                await asyncio.sleep(interval)
                remaining -= interval
            return {"content": [{"type": "text", "text": "Finished waiting."}], "details": {}}
        raise RPCError(-32602, "Unknown tool")

    async def ui_command(self, parent: str | None, name: str) -> dict:
        if parent is None or parent not in self.requests:
            raise RPCError(-32001, "UI requires a live command request")
        view_id = "view-" + uuid.uuid4().hex
        view = View(parent, name)
        self.views[view_id] = view
        try:
            result = await self.host_call(parent, "host.ui.open", {
                "viewId": view_id, "title": "Deployment" if name == "ui_form" else "Counter",
                "surface": "overlay",
                "document": form_document() if name == "ui_form" else counter_document(0),
            })
            view.closing = True
            # Open can settle before the close/update acknowledgement. Let an
            # in-flight event finish before retiring its command parent.
            async with view.lock:
                pass
            if (not isinstance(result, dict) or type(result.get("cancelled")) is not bool
                    or (result["cancelled"] and (
                        set(result) != {"cancelled", "reason"} or not isinstance(result["reason"], str)))
                    or (not result["cancelled"] and (
                        set(result) != {"cancelled", "result"} or not isinstance(result["result"], dict)))
                    or len(encode(result).encode("utf-8")) > 16 * 1024):
                raise RPCError(-32000, "Invalid UI result")
            return {"text": "UI result: " + encode(result)}
        finally:
            view.closing = True
            self.views.pop(view_id, None)

    async def ui_event(self, params: Any) -> dict:
        shape(params, {"parentRequestId", "viewId", "revision", "event"})
        require(valid_id(params["parentRequestId"], "pi-"))
        require(isinstance(params["viewId"], str)
                and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", params["viewId"]) is not None)
        require(type(params["revision"]) is int and 0 <= params["revision"] <= 2**53 - 1)
        event = params["event"]
        require(isinstance(event, dict) and isinstance(event.get("type"), str))
        kind = event["type"]
        if kind == "resize":
            shape(event, {"type", "width", "height"})
            require(all(type(event[k]) is int and 0 < event[k] <= 2**53 - 1
                        for k in ("width", "height")))
        elif kind == "key":
            shape(event, {"type", "key"})
            require(safe_text(event["key"]) and 0 < len(event["key"]) <= 128)
        elif kind == "text":
            shape(event, {"type", "text"})
            require(safe_text(event["text"]))
        elif kind == "change":
            shape(event, {"type", "id", "value"})
            require(isinstance(event["id"], str) and safe_text(event["value"]))
        else:
            raise RPCError(-32602, "Unknown UI event")
        view = self.views.get(params["viewId"])
        if self.ui_timeout is None or view is None:
            raise RPCError(-32001, "UI view is no longer active")
        async with view.lock:
            pending_open = self.reverse.get(view.open_request_id)
            if (view.closing or self.views.get(params["viewId"]) is not view
                    or params["parentRequestId"] != view.parent
                    or view.parent not in self.requests or view.parent in self.cancelled
                    or pending_open is None or pending_open[1].done()):
                raise RPCError(-32001, "UI parent or view is no longer active")
            require(params["revision"] == view.revision, "Invalid UI revision")
            if kind == "change":
                require(view.kind == "ui_form" and event["id"] in {"name", "target"})
                require((event["id"] == "name" and len(event["value"]) <= 256)
                        or (event["id"] == "target" and event["value"] in {"dev", "prod"}))
            # The host owns all form editing, selection, and button submission.
            if view.kind == "ui_counter" and kind == "key":
                key = event["key"]
                if key in {"up", "down"}:
                    require(view.revision < 2**53 - 1, "UI revision limit reached")
                    view.count += 1 if key == "up" else -1
                    view.revision += 1
                    result = await self.host_call(view.parent, "host.ui.update", {
                        "viewId": params["viewId"], "revision": view.revision,
                        "document": counter_document(view.count),
                    })
                    if result != {"applied": True} or type(result.get("applied")) is not bool:
                        raise RPCError(-32000, "UI update was not applied")
                elif key == "enter":
                    view.closing = True
                    result = await self.host_call(view.parent, "host.ui.close", {
                        "viewId": params["viewId"], "result": {"count": view.count},
                    })
                    if result != {}:
                        raise RPCError(-32000, "Invalid UI close response")
            return {}

    async def close(self, graceful: bool = False) -> None:
        if self.closing:
            return
        self.closing = True
        current = asyncio.current_task()
        tasks = [task for task in self.tasks if task is not current]
        for task in tasks:
            task.cancel()
        for _, future in self.reverse.values():
            future.cancel()
        self.reverse.clear()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self.views.clear()
        self.ui_timeout = None
        self.permissions.clear()
        self.initialized = False
        self.requests.clear()
        self.started.clear()
        self.cancelled.clear()
        if graceful:
            try:
                await asyncio.wait_for(self.outgoing.put(None), IO_TIMEOUT)
            except TimeoutError:
                self._discard_output()
        else:
            self._discard_output()
        self.closed.set()

    def _discard_output(self) -> None:
        while not self.outgoing.empty():
            self.outgoing.get_nowait()
        self.outgoing.put_nowait(None)
