"""Fake UI host tests: the service does not render or edit local widgets."""
import asyncio
import json
import unittest
from unittest.mock import patch

from polyglot_example.core import CATALOG, Connection, decode
from test_core import INIT, request, tool

UI_INIT = {**INIT, "permissions": [*INIT["permissions"], "ui.custom"],
           "optionalFeatures": ["tui_v1"], "ui": {"timeoutMs": 300000}}


def reply(message, result):
    return {"jsonrpc": "2.0", "id": message["id"], "result": result}


def event(opened, value, revision=0):
    return {"parentRequestId": opened["params"]["parentRequestId"],
            "viewId": opened["params"]["viewId"], "revision": revision, "event": value}


async def exercise_ui(test, host):
    """Same fake UI exchange over in-memory, stdio, HTTP/SSE and gRPC hosts."""
    await host.send(request("pi-init", "initialize", UI_INIT))
    catalog = (await host.read())["result"]
    test.assertEqual(catalog["features"], ["tui_v1"])
    test.assertEqual([c["name"] for c in catalog["commands"]], ["hello", "ui_form", "ui_counter"])

    await host.send(request("pi-form", "command.execute", tool("ui_form", "")))
    opened = await host.read()
    test.assertEqual(opened["method"], "host.ui.open")
    test.assertEqual(opened["params"]["parentRequestId"], "pi-form")
    test.assertRegex(opened["params"]["viewId"], r"^[A-Za-z0-9_-]{1,64}$")
    test.assertEqual([n["type"] for n in opened["params"]["document"]["children"]],
                     ["frame", "input", "select", "button"])
    # Open is pending; another command and host REQUEST must still be serviced.
    await host.send(request("pi-hello", "command.execute", tool("hello", "reader")))
    test.assertEqual((await host.read())["result"], {"text": "Hello, reader!"})
    await host.send(request("pi-change", "ui.event", event(opened, {
        "type": "change", "id": "name", "value": "Grace"})))
    test.assertEqual(await host.read(), reply({"id": "pi-change"}, {}))
    form_result = {"cancelled": False, "result": {
        "action": "submit", "values": {"name": "Grace", "target": "prod"}}}
    await host.send(reply(opened, form_result))
    response = await host.read()
    test.assertEqual(response["id"], "pi-form")
    test.assertEqual(json.loads(response["result"]["text"].split(": ", 1)[1]), form_result)

    await host.send(request("pi-count", "command.execute", tool("ui_counter", "")))
    counter = await host.read()
    test.assertNotEqual(opened["params"]["viewId"], counter["params"]["viewId"])
    test.assertEqual(counter["params"]["document"]["type"], "frame")
    await host.send(request("pi-resize", "ui.event", event(counter, {
        "type": "resize", "width": 40, "height": 12})))
    test.assertEqual(await host.read(), reply({"id": "pi-resize"}, {}))
    for revision, (key, count) in enumerate([("up", 1), ("up", 2), ("down", 1)]):
        event_id = f"pi-key-{revision}"
        await host.send(request(event_id, "ui.event", event(counter, {"type": "key", "key": key}, revision)))
        update = await host.read()
        test.assertEqual(update["method"], "host.ui.update")
        test.assertEqual(update["params"]["parentRequestId"], "pi-count")
        test.assertEqual(update["params"]["viewId"], counter["params"]["viewId"])
        test.assertEqual(update["params"]["revision"], revision + 1)
        test.assertEqual(update["params"]["document"]["lines"][0][0]["text"], f"Counter: {count}")
        await host.send(reply(update, {"applied": True}))
        test.assertEqual(await host.read(), reply({"id": event_id}, {}))
    await host.send(request("pi-enter", "ui.event", event(counter, {"type": "key", "key": "enter"}, 3)))
    closed = await host.read()
    test.assertEqual(closed["method"], "host.ui.close")
    test.assertEqual(closed["params"]["parentRequestId"], "pi-count")
    test.assertEqual(closed["params"]["result"], {"count": 1})
    # Exercise the race: open resolves before the close request acknowledgement.
    await host.send(reply(counter, {"cancelled": False, "result": {"count": 1}}))
    await host.send(reply(closed, {}))
    responses = {r["id"]: r for r in [await host.read(), await host.read()]}
    test.assertEqual(responses["pi-enter"]["result"], {})
    test.assertIn('"count":1', responses["pi-count"]["result"]["text"])
    await host.send(request("pi-late", "ui.event", event(counter, {"type": "key", "key": "up"}, 3)))
    test.assertEqual((await host.read())["error"]["code"], -32001)


class UITests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.connection = Connection()

    async def asyncTearDown(self):
        await self.connection.close()

    async def send(self, message):
        await self.connection.accept(message)

    async def read(self):
        raw = await asyncio.wait_for(self.connection.outgoing.get(), 2)
        return decode(raw) if raw is not None else None

    async def initialize(self, params=UI_INIT):
        await self.send(request("pi-init", "initialize", params))
        return await self.read()

    async def open(self, name="ui_counter"):
        await self.initialize()
        await self.send(request("pi-command", "command.execute", tool(name, "")))
        return await self.read()

    async def test_fake_host_form_and_counter(self):
        await exercise_ui(self, self)
        self.assertFalse(self.connection.views)
        self.assertFalse(self.connection.reverse)

    async def test_legacy_catalog_exactly_unchanged(self):
        self.assertEqual((await self.initialize(INIT))["result"], CATALOG)
        await self.send(request("pi-ui", "command.execute", tool("ui_form", "")))
        self.assertEqual((await self.read())["error"]["code"], -32602)

    async def test_permission_alone_does_not_select_feature(self):
        params = {**INIT, "permissions": ["ui.custom"]}
        self.assertEqual((await self.initialize(params))["result"], CATALOG)
        self.assertIsNone(self.connection.ui_timeout)

    async def test_unrecognized_offer_is_not_selected(self):
        params = {**UI_INIT, "optionalFeatures": ["future_feature"]}
        self.assertEqual((await self.initialize(params))["result"], CATALOG)

    async def test_invalid_negotiation(self):
        cases = [{**UI_INIT, "permissions": []},
                 {k: v for k, v in UI_INIT.items() if k != "ui"},
                 {**UI_INIT, "optionalFeatures": "tui_v1"},
                 {**UI_INIT, "optionalFeatures": ["tui_v1", "tui_v1"]},
                 *({**UI_INIT, "ui": {"timeoutMs": n}} for n in (True, 0, 999, 900001, 1.5)),
                 {**UI_INIT, "ui": {"timeoutMs": 1000, "extra": True}}]
        for params in cases:
            with self.subTest(params=params):
                self.assertEqual((await self.initialize(params))["error"]["code"], -32602)
                self.assertFalse(self.connection.initialized)
                self.assertIsNone(self.connection.ui_timeout)
        self.assertEqual((await self.initialize())["result"]["features"], ["tui_v1"])

    async def test_invalid_and_foreign_events(self):
        opened = await self.open()
        valid = event(opened, {"type": "key", "key": "up"})
        cases = [({**valid, "parentRequestId": "pi-other"}, -32001),
                 ({**valid, "viewId": "foreign"}, -32001),
                 ({**valid, "viewId": "../bad"}, -32602),
                 ({**valid, "revision": 1}, -32602),
                 ({**valid, "revision": True}, -32602),
                 ({**valid, "extra": 1}, -32602)]
        cases.extend(({**valid, "event": e}, -32602) for e in [
            {"type": "unknown"}, {"type": "key", "key": "up", "extra": 1},
            {"type": "key", "key": "\u001b[A"}, {"type": "text", "text": "\u202e"},
            {"type": "resize", "width": True, "height": 10},
            {"type": "change", "id": "name", "value": "x"}])
        for index, (params, code) in enumerate(cases):
            await self.send(request(f"pi-invalid-{index}", "ui.event", params))
            self.assertEqual((await self.read())["error"]["code"], code)
        self.assertEqual(next(iter(self.connection.views.values())).count, 0)

    async def test_event_notification_cannot_mutate_view(self):
        opened = await self.open()
        await self.send({"jsonrpc": "2.0", "method": "ui.event",
                         "params": event(opened, {"type": "key", "key": "up"})})
        await self.send(request("pi-barrier", "command.execute", tool("hello", "")))
        self.assertEqual((await self.read())["id"], "pi-barrier")
        self.assertEqual(next(iter(self.connection.views.values())).revision, 0)

    async def test_escape_result_and_late_event(self):
        opened = await self.open("ui_form")
        await self.send(reply(opened, {"cancelled": True, "reason": "escape"}))
        self.assertIn('"cancelled":true', (await self.read())["result"]["text"])
        self.assertFalse(self.connection.views)
        await self.send(request("pi-late", "ui.event", event(opened, {"type": "key", "key": "enter"})))
        self.assertEqual((await self.read())["error"]["code"], -32001)

    async def test_parent_cancel_clears_pending_open_and_event(self):
        opened = await self.open()
        await self.send(request("pi-event", "ui.event", event(opened, {"type": "key", "key": "up"})))
        update = await self.read()
        await self.send({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": "pi-command"}})
        responses = [await self.read(), await self.read()]
        self.assertEqual({r["id"] for r in responses}, {"pi-command", "pi-event"})
        self.assertTrue(all(r["error"]["code"] == -32800 for r in responses))
        self.assertFalse(self.connection.views)
        self.assertFalse(self.connection.reverse)
        await self.send(reply(opened, {"cancelled": True, "reason": "cancelled"}))
        await self.send(reply(update, {"applied": True}))
        await self.send(request("pi-late", "ui.event", event(opened, {"type": "key", "key": "up"})))
        self.assertEqual((await self.read())["error"]["code"], -32001)

    async def test_disconnect_clears_context(self):
        await self.open()
        await self.connection.close()
        self.assertFalse(self.connection.views)
        self.assertFalse(self.connection.reverse)
        self.assertFalse(self.connection.requests)
        self.assertFalse(self.connection.permissions)
        self.assertIsNone(self.connection.ui_timeout)

    async def test_ui_open_outlasts_ordinary_timeout(self):
        with patch("polyglot_example.core.CALL_TIMEOUT", 0.01):
            opened = await self.open()
            await asyncio.sleep(0.04)
            self.assertTrue(self.connection.views)
            self.assertTrue(self.connection.outgoing.empty())
            await self.send(reply(opened, {"cancelled": True, "reason": "escape"}))
            self.assertIn("result", await self.read())
        self.assertEqual(self.connection.ui_timeout, 300)

    async def test_command_deadline_is_still_bounded(self):
        await self.initialize({**UI_INIT, "ui": {"timeoutMs": 1000}})
        await self.send(request("pi-command", "command.execute", tool("ui_counter", "")))
        self.assertEqual((await self.read())["method"], "host.ui.open")
        response = await self.read()  # Offered 1000 ms deadline, not 30 seconds.
        self.assertEqual(response["error"]["code"], -32000)
        self.assertFalse(self.connection.views)
        self.assertFalse(self.connection.reverse)

    async def test_opt_in_tool_keeps_ordinary_callback_timeout(self):
        await self.initialize()
        with patch("polyglot_example.core.CALL_TIMEOUT", 0.01):
            await self.send(request("pi-tool", "tool.call", tool("greet", {"name": "Ada"})))
            self.assertEqual((await self.read())["method"], "host.ui.confirm")
            self.assertEqual((await self.read())["error"]["code"], -32000)
        self.assertFalse(self.connection.reverse)

    async def test_stale_revision_after_update(self):
        opened = await self.open()
        params = event(opened, {"type": "key", "key": "up"})
        await self.send(request("pi-up", "ui.event", params))
        update = await self.read()
        await self.send(reply(update, {"applied": True}))
        self.assertEqual((await self.read())["result"], {})
        await self.send(request("pi-stale", "ui.event", params))
        self.assertEqual((await self.read())["error"]["code"], -32602)
        self.assertEqual(next(iter(self.connection.views.values())).count, 1)

    async def test_update_keeps_ordinary_callback_timeout(self):
        opened = await self.open()
        with patch("polyglot_example.core.CALL_TIMEOUT", 0.01):
            await self.send(request("pi-up", "ui.event", event(opened, {"type": "key", "key": "up"})))
            self.assertEqual((await self.read())["method"], "host.ui.update")
            self.assertEqual((await self.read())["error"]["code"], -32000)
        # Host closes on an event failure, rather than replaying it.
        await self.send(reply(opened, {"cancelled": True, "reason": "event failure"}))
        self.assertIn("result", await self.read())
        self.assertFalse(self.connection.views)

    async def test_host_open_error_cleans_view(self):
        opened = await self.open()
        await self.send({"jsonrpc": "2.0", "id": opened["id"],
                         "error": {"code": -32001, "message": "TUI unavailable"}})
        self.assertEqual((await self.read())["error"]["code"], -32000)
        self.assertFalse(self.connection.views)

    async def test_invalid_open_result_cleans_view(self):
        opened = await self.open()
        await self.send(reply(opened, {"cancelled": False, "result": "not an object"}))
        self.assertEqual((await self.read())["error"]["code"], -32000)
        self.assertFalse(self.connection.views)
