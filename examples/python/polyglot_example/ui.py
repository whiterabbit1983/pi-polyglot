"""Safe, declarative demo documents; terminal rendering belongs to the host."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field


UI_COMMANDS = [
    {"name": "ui_form", "description": "Open a hybrid form (interactive TUI only)"},
    {"name": "ui_counter", "description": "Open a remote counter (interactive TUI only)"},
]


@dataclass
class View:
    parent: str
    kind: str
    revision: int = 0
    count: int = 0
    closing: bool = False
    open_request_id: str | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def form_document() -> dict:
    return {"type": "column", "children": [
        {"type": "frame", "lines": [[
            {"text": "Choose a target", "style": "accent", "bold": True}]]},
        {"type": "input", "id": "name", "label": "Name", "value": "Ada"},
        {"type": "select", "id": "target", "label": "Target", "options": [
            {"value": "dev", "label": "Development"},
            {"value": "prod", "label": "Production"}], "value": "dev"},
        {"type": "button", "id": "submit", "label": "Deploy"},
    ]}


def counter_document(count: int) -> dict:
    return {"type": "frame", "lines": [
        [{"text": f"Counter: {count}", "style": "accent", "bold": True}],
        [{"text": "Up/down: change. Enter: submit. Escape: cancel.", "style": "muted"}],
    ]}


def safe_text(value: object) -> bool:
    return (isinstance(value, str) and len(value) <= 4096
            and all(not (ord(c) < 32 or 127 <= ord(c) <= 159
                         or 0x202A <= ord(c) <= 0x202E or 0x2066 <= ord(c) <= 0x2069)
                    for c in value))
