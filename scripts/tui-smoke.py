#!/usr/bin/env python3
"""Actual Pi interactive acceptance via a local POSIX PTY; no provider call."""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
assert NODE, "Node is required"
ANSI = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]")


def main(mode):
    with tempfile.TemporaryDirectory(prefix="polyglot-tui-") as temp:
        config = Path(temp) / "config.json"
        config.write_text(json.dumps({"version": 1, "extensions": [{
            "id": "ui", "transport": "stdio", "command": NODE,
            "args": ["--import", "tsx", str(ROOT / "examples/typescript/server.ts")],
            "cwd": str(ROOT), "permissions": ["ui.custom"],
            "hooks": ["session_start", "before_agent_start", "tool_call"],
            "uiTimeoutMs": 15000,
        }]}))
        probe = Path(temp) / "ready.ts"
        probe.write_text("export default function(pi) { pi.on('session_start',(_,ctx)=>ctx.ui.notify('POLYGLOT_READY','info')); }")
        env = {"PATH": os.environ.get("PATH", ""), "HOME": temp,
               "PI_CODING_AGENT_DIR": str(Path(temp) / "agent"),
               "PI_POLYGLOT_CONFIG": str(config), "PI_OFFLINE": "1",
               "TERM": "xterm-256color", "LANG": "en_US.UTF-8"}
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(temp)
            args = [NODE, str(ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
                    "--no-session", "--offline", "--no-extensions", "--no-mcp", "--no-skills",
                    "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-builtin-tools",
                    "--tui-mode", mode, "-e", str(ROOT / "src/index.ts"), "-e", str(probe)]
            os.execve(NODE, args, env)
        output = bytearray()
        exited = False

        def resize(rows, cols):
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            os.kill(pid, signal.SIGWINCH)

        def expect(text, timeout=15):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if text in ANSI.sub("", output.decode("utf-8", "replace")):
                    return
                readable, _, _ = select.select([fd], [], [], 0.1)
                if readable:
                    try:
                        data = os.read(fd, 65536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            break
                        raise
                    if not data:
                        break
                    output.extend(data)
                    if len(output) > 2 * 1024 * 1024:
                        raise AssertionError("Unexpected terminal output flood")
            raise AssertionError(f"Did not observe {text!r}. Terminal tail: {output[-6000:]!r}")

        def send(value):
            os.write(fd, value)

        try:
            resize(28, 100)
            expect("POLYGLOT_READY")
            output.clear()
            send(b"/pg_ui_ui_counter\r")
            expect("Remote counter")
            send(b"\x1b[A")
            expect("Count: 1")
            resize(20, 44)
            time.sleep(0.15)
            send(b"\r")
            expect('"count":1')
            output.clear()
            resize(10, 100)
            send(b"/pg_ui_ui_form\r")
            expect("Choose a target")
            # The first native input owns focus. Edit, move to select, choose prod, submit.
            send(b"X\t\x1b[B\t\r")
            expect("AdaX")
            expect('"prod"')
            output.clear()
            send(b"/pg_ui_ui_counter\r")
            expect("Remote counter")
            send(b"\x1b")
            expect('"cancelled":true')
            os.kill(pid, signal.SIGTERM)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                readable, _, _ = select.select([fd], [], [], 0.05)
                if readable:
                    try:
                        os.read(fd, 65536)
                    except OSError:
                        pass
                done, status = os.waitpid(pid, os.WNOHANG)
                if done:
                    exited = True
                    assert os.waitstatus_to_exitcode(status) in (0, -signal.SIGTERM), status
                    break
            assert exited, "Pi did not exit after SIGTERM"
            print(f"PASS real Pi PTY ({mode}): remote counter, arrow input, resize, inline form edit/select/submit at 10 rows, Escape and shutdown. No model request.")
        finally:
            if not exited:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)
            os.close(fd)


if __name__ == "__main__":
    for tui_mode in ("regular", "fullscreen"):
        main(tui_mode)
