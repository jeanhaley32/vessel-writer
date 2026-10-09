"""Activity feed — structured events for what the resident session is doing.

This reads the resident session's transcript on disk and emits typed events, so
a client can style and filter them rather than printing terminal text. It is
the only view of that session the writer serves.

Tool *results* are never emitted: they carry whatever a command printed, which
on this box includes vault reads and account figures. Secret-shaped text is
redacted from everything that does go out. The feed is for watching work
happen, not for mirroring a session's contents to a browser.
"""
# That guarantee is why the raw tmux screen-scrape (the old /api/insight route)
# is gone: a terminal pane renders command output, so a page serving both could
# not honestly make it. Raw text does not come back into the writer.
from __future__ import annotations

import asyncio
import json
import logging
import os

from fastapi import APIRouter, Request
from fastapi.responses import Response, StreamingResponse

from . import registry
from .transcript import follow

log = logging.getLogger("vessel-writer.activity")

BACKLOG = int(os.environ.get("ACTIVITY_BACKLOG", "60"))
# Off unless asked for. A fresh install should not start reading whatever
# Claude Code session happens to run on its machine.
ENABLED = os.environ.get("ACTIVITY_ENABLED") == "1"

router = APIRouter()

_recent: list[str] = []
_subscribers: set[asyncio.Queue] = set()
_pump: asyncio.Task | None = None


async def _read_events(queue: asyncio.Queue):
    """Bridge the blocking tailer onto the event loop."""
    stream = follow()
    while True:
        event = await asyncio.to_thread(next, stream, None)
        if event is None:
            return
        await queue.put(event)


async def _broadcast():
    inbox: asyncio.Queue = asyncio.Queue()
    reader = asyncio.create_task(_read_events(inbox))
    try:
        while True:
            payload = json.dumps(await inbox.get())
            _recent.append(payload)
            del _recent[:-BACKLOG]
            for q in list(_subscribers):
                try:
                    q.put_nowait(payload)
                except asyncio.QueueFull:
                    pass           # a wedged client loses frames, never blocks the rest
    finally:
        reader.cancel()


def _ensure_pump():
    """Start tailing on the first subscriber, not at import.

    A writer with nobody watching should not be reading a transcript on a timer,
    and tests that never open the feed should not spawn a thread at all.
    """
    global _pump
    if _pump is None or _pump.done():
        _pump = asyncio.create_task(_broadcast())


@router.get("/api/activity/stream")
async def activity_stream(request: Request):
    if not ENABLED:
        return Response(status_code=204)     # an EventSource stops, rather than retrying, on 204
    _ensure_pump()
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    history = list(_recent)
    _subscribers.add(queue)

    async def gen():
        try:
            for payload in history:
                yield f"data: {payload}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=20)
                    yield f"data: {payload}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            _subscribers.discard(queue)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


registry.route(router)
