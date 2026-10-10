"""Everything about one installation that the code must not assume.

Names, where data lives, and whether a chat relay exists all come from the
environment, with defaults that suit a fresh clone: data under ./data, a
generic owner and assistant, and no relay (so the chat pane stays hidden).
"""
from __future__ import annotations

import os
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data"


def _path(var: str, default: Path) -> Path:
    return Path(os.path.expanduser(os.environ.get(var) or str(default)))


OWNER_NAME = os.environ.get("WRITER_OWNER_NAME", "You")
ASSISTANT_NAME = os.environ.get("WRITER_ASSISTANT_NAME", "Assistant")
# Base URL of the chat relay (SSE at <base>/stream, POST at <base>/send), or
# empty for none. Without one, the chat pane and active listening are hidden.
RELAY_CHAT = os.environ.get("WRITER_RELAY_CHAT", "").rstrip("/")

WRITER_ROOT = _path("WRITER_ROOT", DATA / "writing")
STATE_DIR = _path("WRITER_STATE_DIR", DATA / "state")
CLIENTLOG = _path("WRITER_CLIENTLOG", DATA / "client.log")


def browser_config() -> dict:
    """What the page needs to know, injected into index.html."""
    return {"owner": OWNER_NAME, "assistant": ASSISTANT_NAME, "relay": RELAY_CHAT}
