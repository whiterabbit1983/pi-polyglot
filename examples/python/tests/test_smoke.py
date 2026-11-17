"""Real local processes and sockets. No Pi installation or model calls."""
import asyncio
import contextlib
import io
import os
from pathlib import Path
import secrets
import socket
import sys
import unittest

import aiohttp
import grpc

from polyglot_example.core import MAX_FRAME, decode, encode
from polyglot_example.generated import extension_pb2, extension_pb2_grpc
from test_core import INIT, request, tool
from test_ui import exercise_ui

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Client:
    def __init__(self, send, source, cleanup):
        self.send = send
        self.cleanup = cleanup
        self.queue = asyncio.Queue(64)
        self.error = None

        async def pump():
            try:
                async for raw in source():
                    await self.queue.put(decode(raw))
            except Exception as exc:
                self.error = exc
            finally:
                await self.queue.put(None)

        self.task = asyncio.create_task(pump())

    async def read(self):
        result = await asyncio.wait_for(self.queue.get(), 5)
        if result is None and self.error:
            raise self.error
        return result

    async def terminal(self, id):
        while (message := await self.read()) is not None:
            if message.get("id") == id:
                return message
            if message.get("method") != "progress":
                raise AssertionError(f"Unexpected message: {message}")
        raise AssertionError("Unexpected EOF")

    async def close(self):
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)
        await self.cleanup()


class SmokeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.processes = []
        self.clients = []
        self.token = secrets.token_urlsafe(32)
        self.web = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10))
        self.channels = []

    async def asyncTearDown(self):
        for client in self.clients:
            await client.close()
        for channel in self.channels:
            await channel.close()
        await self.web.close()
        for process in self.processes:
            if process.returncode is None:
                process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 8)
            except TimeoutError:
                process.kill()
                await process.wait()
            if process.stderr:
                stderr = (await process.stderr.read()).decode()
                self.assertNotIn("Traceback", stderr)
                self.assertNotIn(self.token, stderr)

    @property
    def headers(self):
        return {"Authorization": "Bearer " + self.token}

    async def start(self, transport):
        port = free_port()
        process = await asyncio.create_subprocess_exec(
            sys.executable, str(ROOT / "server.py"), "--transport", transport, "--port", str(port),
            cwd=ROOT, env={**os.environ, "POLYGLOT_TOKEN": self.token},
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        self.processes.append(process)
        if transport != "stdio":
            ready = await asyncio.wait_for(process.stderr.readline(), 10)
            self.assertIn(b"listening on 127.0.0.1:", ready)
        return process, port

    async def stdio_client(self, process):
        async def send(message):
            process.stdin.write(encode(message).encode() + b"\n")
            await process.stdin.drain()

        async def source():
            while raw := await process.stdout.readline():
                yield raw

        async def cleanup():
            process.stdin.close()

        client = Client(send, source, cleanup)
        self.clients.append(client)
        return client

    async def http_client(self, port):
        base = f"http://127.0.0.1:{port}"
        async with self.web.post(base + "/sessions", headers=self.headers, json={}) as response:
            self.assertEqual(response.status, 201)
            id = (await response.json())["sessionId"]
        url = base + "/sessions/" + id
        stream = await self.web.get(url + "/events", headers=self.headers)
        self.assertEqual(stream.status, 200)
        self.assertEqual(stream.headers["Content-Type"], "text/event-stream")
        self.assertEqual(await stream.content.readline(), b": ready\n")

        async def send(message):
            async with self.web.post(url + "/messages", headers=self.headers, data=encode(message)) as response:
                self.assertEqual(response.status, 202, await response.text())

        async def source():
            while raw := await stream.content.readline():
                if raw.startswith(b"data: "):
                    yield raw[6:].rstrip(b"\n")

        async def cleanup():
            stream.close()
            async with self.web.delete(url, headers=self.headers) as response:
                self.assertIn(response.status, (204, 404))

        client = Client(send, source, cleanup)
        client.url = url
        client.stream = stream
        self.clients.append(client)
        return client

    async def grpc_client(self, port):
        channel = grpc.aio.insecure_channel(f"127.0.0.1:{port}", options=[
            ("grpc.max_receive_message_length", MAX_FRAME + 16),
            ("grpc.max_send_message_length", MAX_FRAME + 16),
        ])
        self.channels.append(channel)
        stream = extension_pb2_grpc.ExtensionStub(channel).Connect(
            metadata=(("authorization", "Bearer " + self.token),))

        async def send(message):
            await stream.write(extension_pb2.Frame(json=encode(message)))

        async def source():
            while (frame := await stream.read()) is not grpc.aio.EOF:
                yield frame.json

        async def cleanup():
            stream.cancel()

        client = Client(send, source, cleanup)
        self.clients.append(client)
        return client

    async def initialize(self, client):
        await client.send(request("pi-init", "initialize", INIT))
        result = (await client.terminal("pi-init"))["result"]
        self.assertEqual([t["name"] for t in result["tools"]], ["greet", "wait"])

    async def exercise(self, client):
        await self.initialize(client)
        await client.send(request("pi-greet", "tool.call", tool("greet", {"name": "Ada"})))
        confirm = await client.read()
        self.assertEqual(confirm["method"], "host.ui.confirm")
        self.assertEqual(confirm["params"]["parentRequestId"], "pi-greet")
        # The reader and other handlers must continue while confirmation is pending.
        await client.send(request("pi-hello", "command.execute", tool("hello", "friend")))
        self.assertEqual((await client.terminal("pi-hello"))["result"], {"text": "Hello, friend!"})
        await client.send({"jsonrpc": "2.0", "id": confirm["id"], "result": {"confirmed": True}})
        notify = await client.read()
        self.assertEqual(notify["method"], "host.ui.notify")
        self.assertEqual(notify["params"]["parentRequestId"], "pi-greet")
        await client.send({"jsonrpc": "2.0", "id": notify["id"], "result": {}})
        self.assertEqual((await client.terminal("pi-greet"))["result"]["content"][0]["text"], "Hello, Ada!")
        for name, event in [
            ("session_start", {"reason": "new"}),
            ("before_agent_start", {"prompt": "test", "systemPrompt": "unchanged"}),
            ("tool_call", {"toolName": "read", "toolCallId": "call-1", "input": {"path": "x"}}),
        ]:
            await client.send(request("pi-" + name, "hook.run", {
                "name": name, "event": event, "context": {"cwd": "/tmp"}}))
            self.assertEqual((await client.terminal("pi-" + name))["result"], {})
        await client.send(request("pi-wait", "tool.call", tool("wait", {"milliseconds": 10000})))
        progress = await client.read()
        self.assertEqual(progress["method"], "progress")
        self.assertEqual(progress["params"]["requestId"], "pi-wait")
        await client.send({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": "pi-wait"}})
        self.assertEqual((await client.terminal("pi-wait"))["error"]["code"], -32800)
        await client.send(request("pi-zero", "tool.call", tool("wait", {"milliseconds": 0})))
        self.assertEqual((await client.terminal("pi-zero"))["result"]["content"][0]["text"], "Finished waiting.")
        await client.send(request("pi-stop", "shutdown", {}))
        self.assertEqual((await client.terminal("pi-stop"))["result"], {})
        self.assertIsNone(await client.read())

    async def test_stdio(self):
        process, _ = await self.start("stdio")
        await self.exercise(await self.stdio_client(process))
        self.assertEqual(await asyncio.wait_for(process.wait(), 5), 0)

    async def test_ui_stdio(self):
        process, _ = await self.start("stdio")
        await exercise_ui(self, await self.stdio_client(process))

    async def test_ui_http(self):
        _, port = await self.start("http")
        await exercise_ui(self, await self.http_client(port))

    async def test_ui_grpc(self):
        _, port = await self.start("grpc")
        await exercise_ui(self, await self.grpc_client(port))

    async def test_stdio_eof_cancels_pending_callback(self):
        process, _ = await self.start("stdio")
        client = await self.stdio_client(process)
        await self.initialize(client)
        await client.send(request("pi-g", "tool.call", tool("greet", {"name": "Ada"})))
        self.assertEqual((await client.read())["method"], "host.ui.confirm")
        process.stdin.close()
        self.assertIsNone(await client.read())
        self.assertEqual(await asyncio.wait_for(process.wait(), 5), 0)

    async def test_stdio_oversized_frame(self):
        process, _ = await self.start("stdio")
        process.stdin.write(b"x" * (MAX_FRAME + 2) + b"\n")
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            await process.stdin.drain()
        self.assertEqual(await asyncio.wait_for(process.wait(), 5), 0)
        self.assertEqual(await process.stdout.read(), b"")

    async def test_http(self):
        process, port = await self.start("http")
        await self.exercise(await self.http_client(port))
        self.assertIsNone(process.returncode)
        # Shutdown must not terminate the listener.
        await self.exercise(await self.http_client(port))

    async def test_grpc(self):
        process, port = await self.start("grpc")
        await self.exercise(await self.grpc_client(port))
        self.assertIsNone(process.returncode)
        await self.exercise(await self.grpc_client(port))

    async def test_http_auth_and_limits(self):
        _, port = await self.start("http")
        base = f"http://127.0.0.1:{port}"
        async with self.web.post(base + "/sessions", json={}) as response:
            self.assertEqual(response.status, 401)
        client = await self.http_client(port)
        for method, path in [("GET", "/events"), ("POST", "/messages"), ("DELETE", "")]:
            async with self.web.request(method, client.url + path, headers={"Authorization": "Bearer wrong"}) as response:
                self.assertEqual(response.status, 401)
        async with self.web.get(client.url + "/events", headers=self.headers) as response:
            self.assertEqual(response.status, 409)
        # The inclusive frame boundary is valid, even before initialization.
        envelope = request("pi-boundary", "unknown", {"padding": ""})
        envelope["params"]["padding"] = "x" * (MAX_FRAME - len(encode(envelope).encode()))
        boundary = encode(envelope).encode()
        self.assertEqual(len(boundary), MAX_FRAME)
        async with self.web.post(client.url + "/messages", headers=self.headers, data=io.BytesIO(boundary)) as response:
            self.assertEqual(response.status, 202)
        self.assertEqual((await client.terminal("pi-boundary"))["error"]["code"], -32601)
        async with self.web.post(client.url + "/messages", headers=self.headers, data=io.BytesIO(b"x" * (MAX_FRAME + 1))) as response:
            self.assertEqual(response.status, 413)
        async with self.web.delete(client.url, headers=self.headers) as response:
            self.assertEqual(response.status, 204)
        self.assertIsNone(await client.read())
        async with self.web.post(client.url + "/messages", headers=self.headers, json={}) as response:
            self.assertEqual(response.status, 404)

    async def test_http_lost_stream_retires_session(self):
        _, port = await self.start("http")
        client = await self.http_client(port)
        await self.initialize(client)
        await client.send(request("pi-g", "tool.call", tool("greet", {"name": "Ada"})))
        self.assertEqual((await client.read())["method"], "host.ui.confirm")
        client.stream.close()
        for _ in range(40):
            async with self.web.get(client.url + "/events", headers=self.headers) as response:
                if response.status == 404:
                    break
            await asyncio.sleep(0.025)
        else:
            self.fail("Lost SSE stream did not retire the session")

    async def test_grpc_auth_and_frame_limit(self):
        _, port = await self.start("grpc")
        channel = grpc.aio.insecure_channel(f"127.0.0.1:{port}")
        self.channels.append(channel)
        stub = extension_pb2_grpc.ExtensionStub(channel)
        for metadata in [(), (("authorization", "Bearer wrong"),)]:
            stream = stub.Connect(metadata=metadata)
            with self.assertRaises(grpc.aio.AioRpcError) as caught:
                await stream.read()
            self.assertEqual(caught.exception.code(), grpc.StatusCode.UNAUTHENTICATED)
        stream = stub.Connect(metadata=(("authorization", "Bearer " + self.token),))
        await stream.write(extension_pb2.Frame(json="x" * (MAX_FRAME + 1)))
        with self.assertRaises(grpc.aio.AioRpcError) as caught:
            await stream.read()
        self.assertEqual(caught.exception.code(), grpc.StatusCode.INVALID_ARGUMENT)

    async def check_isolation(self, factory, port):
        a, b = await factory(port), await factory(port)
        await self.initialize(a)
        await self.initialize(b)
        await a.send(request("pi-g", "tool.call", tool("greet", {"name": "Ada"})))
        reverse = await a.read()
        await b.send({"jsonrpc": "2.0", "id": reverse["id"], "result": {"confirmed": True}})
        await a.send(request("pi-hello", "command.execute", tool("hello", "")))
        self.assertEqual((await a.terminal("pi-hello"))["result"], {"text": "Hello, world!"})
        await b.send(request("pi-shutdown", "shutdown", {}))
        self.assertEqual((await b.terminal("pi-shutdown"))["result"], {})
        self.assertIsNone(await b.read())
        await a.send({"jsonrpc": "2.0", "id": reverse["id"], "result": {"confirmed": False}})
        self.assertEqual((await a.terminal("pi-g"))["error"]["code"], -32000)

    async def test_http_isolation(self):
        _, port = await self.start("http")
        await self.check_isolation(self.http_client, port)

    async def test_grpc_isolation(self):
        _, port = await self.start("grpc")
        await self.check_isolation(self.grpc_client, port)

    async def test_network_requires_token(self):
        for transport in ("http", "grpc"):
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "polyglot_example", "--transport", transport,
                cwd=ROOT, env={k: v for k, v in os.environ.items() if k != "POLYGLOT_TOKEN"},
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout, stderr = await asyncio.wait_for(process.communicate(), 5)
            self.assertEqual(process.returncode, 2)
            self.assertEqual(stdout, b"")
            self.assertIn(b"POLYGLOT_TOKEN", stderr)
