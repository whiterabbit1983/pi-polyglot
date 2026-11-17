"""Loopback-only development transports. No Pi SDK is used."""
from __future__ import annotations

import asyncio
import hmac
import secrets
import sys
import time
from dataclasses import dataclass

from .core import Connection, IO_TIMEOUT, MAX_FRAME, ProtocolError, decode

MAX_SESSIONS = 128
ORPHAN_TTL = 30


async def stdio() -> None:
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_FRAME + 1)
    read_transport, _ = await loop.connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    write_transport, protocol = await loop.connect_write_pipe(
        lambda: asyncio.streams.FlowControlMixin(loop=loop), sys.stdout.buffer)
    writer = asyncio.StreamWriter(write_transport, protocol, None, loop)
    connection = Connection()

    async def read_frames() -> None:
        try:
            while True:
                raw = await reader.readline()
                if not raw:
                    break
                if not raw.endswith(b"\n"):
                    raise ProtocolError("Unterminated frame")
                await connection.accept(decode(raw[:-1]))
        except (ProtocolError, ValueError, OSError):
            pass  # No untrusted input, secrets, or tracebacks on stdout/stderr.
        finally:
            await connection.close()

    async def write_frames() -> None:
        while (raw := await connection.outgoing.get()) is not None:
            writer.write(raw.encode("utf-8") + b"\n")
            await asyncio.wait_for(writer.drain(), IO_TIMEOUT)

    reader_task = asyncio.create_task(read_frames())
    try:
        await write_frames()
    except (OSError, TimeoutError):
        pass
    finally:
        reader_task.cancel()
        await connection.close()
        await asyncio.gather(reader_task, return_exceptions=True)
        read_transport.close()
        write_transport.close()


@dataclass
class Session:
    connection: Connection
    created: float
    consumer: asyncio.Task | None = None


def http_app(token: str):
    from aiohttp import web

    sessions: dict[str, Session] = {}

    @web.middleware
    async def authorize(request, handler):
        values = request.headers.getall("Authorization", [])
        if len(values) != 1 or not hmac.compare_digest(
                values[0].encode(), ("Bearer " + token).encode()):
            raise web.HTTPUnauthorized()
        return await handler(request)

    # Allow library boundary differences; enforce the exact inclusive limit below.
    app = web.Application(middlewares=[authorize], client_max_size=MAX_FRAME + 1)

    async def payload(request):
        raw = await request.read()
        if len(raw) > MAX_FRAME:
            raise web.HTTPRequestEntityTooLarge(max_size=MAX_FRAME, actual_size=len(raw))
        try:
            return decode(raw)
        except ProtocolError:
            raise web.HTTPBadRequest(text="Invalid frame") from None

    def lookup(request) -> tuple[str, Session]:
        session_id = request.match_info["session_id"]
        session = sessions.get(session_id)
        if session is None or session.connection.closing:
            raise web.HTTPNotFound()
        return session_id, session

    async def create(request):
        if await payload(request) != {}:
            raise web.HTTPBadRequest(text="Expected empty object")
        if len(sessions) >= MAX_SESSIONS:
            raise web.HTTPServiceUnavailable(text="Session limit reached")
        session_id = secrets.token_urlsafe(32)
        sessions[session_id] = Session(Connection(), time.monotonic())
        return web.json_response({"sessionId": session_id}, status=201)

    async def messages(request):
        _, session = lookup(request)
        if session.consumer is None:
            raise web.HTTPConflict(text="Open the event stream first")
        message = await payload(request)
        try:
            await session.connection.accept(message)
        except ProtocolError:
            await session.connection.close()
            raise web.HTTPBadRequest(text="Invalid envelope") from None
        return web.Response(status=202)

    async def events(request):
        session_id, session = lookup(request)
        if session.consumer is not None:
            raise web.HTTPConflict(text="An event consumer is already connected")
        session.consumer = asyncio.current_task()
        response = web.StreamResponse(headers={
            "Content-Type": "text/event-stream", "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        })
        try:
            await asyncio.wait_for(response.prepare(request), IO_TIMEOUT)
            await asyncio.wait_for(response.write(b": ready\n\n"), IO_TIMEOUT)
            while True:
                try:
                    raw = await asyncio.wait_for(session.connection.outgoing.get(), 10)
                except TimeoutError:
                    await asyncio.wait_for(response.write(b": keepalive\n\n"), IO_TIMEOUT)
                    continue
                if raw is None:
                    break
                await asyncio.wait_for(response.write(b"data: " + raw.encode() + b"\n\n"), IO_TIMEOUT)
            await asyncio.wait_for(response.write_eof(), IO_TIMEOUT)
        except (OSError, TimeoutError):
            pass
        finally:
            sessions.pop(session_id, None)
            await session.connection.close()
        return response

    async def delete(request):
        session_id, session = lookup(request)
        sessions.pop(session_id, None)
        await session.connection.close()
        return web.Response(status=204)

    async def lifecycle(app):
        async def reap():
            while True:
                await asyncio.sleep(5)
                for session_id, session in list(sessions.items()):
                    if session.consumer is None and time.monotonic() - session.created > ORPHAN_TTL:
                        sessions.pop(session_id, None)
                        await session.connection.close()

        reaper = asyncio.create_task(reap())
        yield
        reaper.cancel()
        await asyncio.gather(reaper, return_exceptions=True)
        await asyncio.gather(*(session.connection.close() for session in list(sessions.values())))
        sessions.clear()

    app.cleanup_ctx.append(lifecycle)
    app.router.add_post("/sessions", create)
    app.router.add_get("/sessions/{session_id}/events", events)
    app.router.add_post("/sessions/{session_id}/messages", messages)
    app.router.add_delete("/sessions/{session_id}", delete)
    return app


async def http(port: int, token: str, stop: asyncio.Event) -> None:
    from aiohttp import web

    runner = web.AppRunner(http_app(token), access_log=None, handler_cancellation=True,
                           shutdown_timeout=5)
    await runner.setup()
    try:
        await web.TCPSite(runner, "127.0.0.1", port).start()
        print(f"HTTP listening on 127.0.0.1:{port}", file=sys.stderr)
        await stop.wait()
    finally:
        await runner.cleanup()


async def grpc_server(port: int, token: str, stop: asyncio.Event) -> None:
    import grpc
    from .generated import extension_pb2, extension_pb2_grpc

    class Extension(extension_pb2_grpc.ExtensionServicer):
        def __init__(self):
            self.active = 0

        async def Connect(self, request_iterator, context):
            values = [item.value for item in context.invocation_metadata() if item.key == "authorization"]
            if len(values) != 1 or not hmac.compare_digest(
                    values[0].encode(), ("Bearer " + token).encode()):
                await context.abort(grpc.StatusCode.UNAUTHENTICATED, "Authentication required")
            if self.active >= MAX_SESSIONS:
                await context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, "Connection limit reached")
            self.active += 1
            connection = Connection()
            failure = None

            async def read_frames():
                nonlocal failure
                try:
                    async for frame in request_iterator:
                        await connection.accept(decode(frame.json))
                except ProtocolError:
                    failure = grpc.StatusCode.INVALID_ARGUMENT
                except Exception:
                    failure = grpc.StatusCode.CANCELLED
                finally:
                    await connection.close()

            reader = asyncio.create_task(read_frames())
            try:
                while (raw := await connection.outgoing.get()) is not None:
                    await asyncio.wait_for(context.write(extension_pb2.Frame(json=raw)), IO_TIMEOUT)
                if failure is not None:
                    await context.abort(failure, "Connection failed")
            except TimeoutError:
                await context.abort(grpc.StatusCode.DEADLINE_EXCEEDED, "Slow consumer")
            finally:
                reader.cancel()
                await connection.close()
                await asyncio.gather(reader, return_exceptions=True)
                self.active -= 1

    server = grpc.aio.server(options=[
        ("grpc.max_receive_message_length", MAX_FRAME + 16),
        ("grpc.max_send_message_length", MAX_FRAME + 16),
        ("grpc.max_concurrent_streams", MAX_SESSIONS),
    ])
    extension_pb2_grpc.add_ExtensionServicer_to_server(Extension(), server)
    if not server.add_insecure_port(f"127.0.0.1:{port}"):
        raise RuntimeError("Cannot bind gRPC port")
    await server.start()
    print(f"gRPC listening on 127.0.0.1:{port}", file=sys.stderr)
    try:
        await stop.wait()
    finally:
        await server.stop(5)
