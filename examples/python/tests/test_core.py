import asyncio
import unittest
from unittest.mock import patch

from polyglot_example.core import Connection, MAX_FRAME, MAX_PENDING, ProtocolError, decode, encode

INIT = {"protocolVersion": "0.1", "client": {"name": "test", "version": "0.1.0"},
        "permissions": ["ui.notify", "ui.confirm"], "context": {"cwd": "/tmp"}}


def request(id, method, params):
    return {"jsonrpc": "2.0", "id": id, "method": method, "params": params}


def tool(name, arguments):
    return {"name": name, "arguments": arguments, "context": {"cwd": "/tmp"}}


class CoreTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.connection = Connection()
        await self.connection.accept(request("pi-init", "initialize", INIT))
        self.catalog = (await self.read())["result"]

    async def asyncTearDown(self):
        await self.connection.close()

    async def read(self):
        raw = await asyncio.wait_for(self.connection.outgoing.get(), 2)
        return decode(raw) if raw is not None else None

    async def test_catalog(self):
        self.assertEqual([t["name"] for t in self.catalog["tools"]], ["greet", "wait"])
        self.assertEqual(self.catalog["hooks"], ["session_start", "before_agent_start", "tool_call"])

    async def test_unknown_method(self):
        await self.connection.accept(request("pi-x", "unknown", {}))
        self.assertEqual((await self.read())["error"]["code"], -32601)

    async def test_argument_validation(self):
        cases = [("greet", {}), ("greet", {"name": "x" * 101}), ("greet", {"name": 3}),
                 ("greet", {"name": "x", "extra": True}), ("wait", {"milliseconds": True}),
                 ("wait", {"milliseconds": -1}), ("wait", {"milliseconds": 10001}),
                 ("wait", {"milliseconds": 1.2}), ("wait", None), ("unknown", {})]
        for index, (name, args) in enumerate(cases):
            with self.subTest(name=name, args=args):
                await self.connection.accept(request(f"pi-{index}", "tool.call", tool(name, args)))
                self.assertEqual((await self.read())["error"]["code"], -32602)

    async def test_invalid_request_shapes(self):
        cases = [("initialize", {}), ("command.execute", tool("hello", {})),
                 ("hook.run", {"name": "other", "event": {}, "context": {"cwd": "/tmp"}}),
                 ("shutdown", {"extra": True}), ("tool.call", {"name": "greet"})]
        for index, (method, params) in enumerate(cases):
            await self.connection.accept(request(f"pi-{index}", method, params))
            self.assertEqual((await self.read())["error"]["code"], -32602)

    async def test_cancel_before_handler_starts(self):
        await self.connection.accept(request("pi-w", "tool.call", tool("wait", {"milliseconds": 10000})))
        await self.connection.accept({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": "pi-w"}})
        self.assertEqual((await self.read())["error"]["code"], -32800)
        await asyncio.sleep(0)
        self.assertNotIn("pi-w", self.connection.requests)

    async def test_cancel_wait(self):
        await self.connection.accept(request("pi-w", "tool.call", tool("wait", {"milliseconds": 10000})))
        self.assertEqual((await self.read())["method"], "progress")
        cancel = {"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": "pi-w"}}
        await self.connection.accept(cancel)
        await self.connection.accept(cancel)
        self.assertEqual((await self.read())["error"]["code"], -32800)
        self.assertFalse(self.connection.closing)

    async def test_late_cancel_during_terminal_write_does_not_close_connection(self):
        sending, release = asyncio.Event(), asyncio.Event()
        original = self.connection.send

        async def delayed_send(message):
            sending.set()
            await release.wait()
            await original(message)

        with patch.object(self.connection, "send", delayed_send):
            await self.connection.accept(request("pi-h", "command.execute", tool("hello", "")))
            await sending.wait()
            await self.connection.accept({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": "pi-h"}})
            release.set()
            self.assertEqual((await self.read())["result"], {"text": "Hello, world!"})
        self.assertFalse(self.connection.closing)

    async def test_cancel_reverse_call_and_ignore_late_response(self):
        await self.connection.accept(request("pi-g", "tool.call", tool("greet", {"name": "Ada"})))
        reverse = await self.read()
        await self.connection.accept({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": "pi-g"}})
        self.assertEqual((await self.read())["error"]["code"], -32800)
        await self.connection.accept({"jsonrpc": "2.0", "id": reverse["id"], "result": {"confirmed": True}})
        self.assertFalse(self.connection.reverse)

    async def test_confirmation_rejected(self):
        await self.connection.accept(request("pi-g", "tool.call", tool("greet", {"name": "Ada"})))
        reverse = await self.read()
        self.assertEqual(reverse["params"]["parentRequestId"], "pi-g")
        await self.connection.accept({"jsonrpc": "2.0", "id": reverse["id"], "result": {"confirmed": False}})
        self.assertEqual((await self.read())["error"]["code"], -32000)

    async def test_missing_permission_never_approves(self):
        self.connection.permissions.clear()
        await self.connection.accept(request("pi-g", "tool.call", tool("greet", {"name": "Ada"})))
        self.assertEqual((await self.read())["error"]["code"], -32000)
        self.assertFalse(self.connection.reverse)

    async def test_reverse_timeout(self):
        with patch("polyglot_example.core.CALL_TIMEOUT", 0.01):
            await self.connection.accept(request("pi-g", "tool.call", tool("greet", {"name": "Ada"})))
            self.assertEqual((await self.read())["method"], "host.ui.confirm")
            self.assertEqual((await self.read())["error"]["code"], -32000)
        self.assertFalse(self.connection.reverse)

    async def test_reverse_errors_do_not_leak_host_messages(self):
        await self.connection.accept(request("pi-g", "tool.call", tool("greet", {"name": "Ada"})))
        reverse = await self.read()
        await self.connection.accept({"jsonrpc": "2.0", "id": reverse["id"],
                                      "error": {"code": -32000, "message": "secret credential"}})
        response = await self.read()
        self.assertNotIn("secret", str(response))
        self.assertEqual(response["error"]["code"], -32000)

    async def test_notifications_have_no_result(self):
        await self.connection.accept({"jsonrpc": "2.0", "method": "command.execute", "params": tool("hello", "")})
        await asyncio.sleep(0.01)
        self.assertTrue(self.connection.outgoing.empty())

    async def test_pending_limit(self):
        for index in range(MAX_PENDING + 1):
            await self.connection.accept(request(f"pi-{index}", "tool.call", tool("wait", {"milliseconds": 10000})))
        response = await self.read()
        self.assertEqual(response["id"], f"pi-{MAX_PENDING}")
        self.assertEqual(response["error"]["code"], -32000)
        self.assertLessEqual(len(self.connection.tasks), MAX_PENDING)

    async def test_output_queue_is_bounded(self):
        for _ in range(self.connection.outgoing.maxsize):
            await self.connection.send({"jsonrpc": "2.0", "method": "test"})
        with patch("polyglot_example.core.IO_TIMEOUT", 0.01):
            with self.assertRaises(ProtocolError):
                await self.connection.send({"jsonrpc": "2.0", "method": "test"})

    async def test_shutdown_flushes_response(self):
        await self.connection.accept(request("pi-end", "shutdown", {}))
        self.assertEqual(await self.read(), {"jsonrpc": "2.0", "id": "pi-end", "result": {}})
        self.assertIsNone(await self.read())
        await self.connection.closed.wait()
        self.assertTrue(self.connection.closing)

    async def test_envelope_validation(self):
        cases = [{}, {"jsonrpc": "2.0", "method": "test", "id": 1},
                 {"jsonrpc": "2.0", "method": "test", "id": "ext-1"},
                 {"jsonrpc": "2.0", "id": "ext-1", "result": {}, "error": {}},
                 {"jsonrpc": "2.0", "id": "ext-1", "error": {"code": True, "message": "x"}}]
        for case in cases:
            with self.assertRaises(ProtocolError):
                await self.connection.accept(case)

    def test_frame_validation(self):
        for raw in [b"x" * (MAX_FRAME + 1), b"\xff", b"[]", b'{"x":NaN}', '{}'.encode('utf-16')]:
            with self.assertRaises(ProtocolError):
                decode(raw)
        with self.assertRaises(ProtocolError):
            encode({"text": "x" * MAX_FRAME})
