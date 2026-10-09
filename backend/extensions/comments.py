"""Inline comments — Rodin's commentary on a document, anchored to spans.

Why this endpoint exists at all. relayd already carries annotations, but on its
loopback-only webhook mux at 127.0.0.1:9210, which a browser cannot reach, and
its payload is {file, line, text, kind} — a line number with no span, while a
CodeMirror `Decoration.mark` needs from/to. So the writer owns the transport
instead, and the payload carries an optional `quote`: the exact text the comment
is about. The browser resolves a quote to a real span, and falls back to the
line's own range when there is no quote. A line-based producer (the existing
relayd annotate shape) therefore still works, unchanged, with line-wide spans.

Bounded, and persisted off the writing path. A comment is commentary on a
draft in flight rather than a record, but a restart is not the owner deciding
he is done with it, and losing one mid-draft reads as the feature being
broken. Nothing here is called from on_save, so the small state write cannot
cost a save. The per-path cap is the relevance bar: a producer that floods a
document gets 429 rather than burying the text it is commenting on.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
import time
import uuid

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

import auth

from . import registry, statefile

log = logging.getLogger("vessel-writer.comments")

PER_DOC_CAP = int(os.environ.get("COMMENTS_PER_DOC_CAP", "60"))
MIN_INTERVAL_S = float(os.environ.get("COMMENTS_MIN_INTERVAL_S", "0"))
TEXT_CAP = 2000
REPLY_CAP = 50
AUTHORS = ("jean", "rodin")
REPLY_URL = "http://127.0.0.1:8791/api/comments/reply"

router = APIRouter()

_STATE = "comments"
_persisted = statefile.load(_STATE, {})
_by_path: dict[str, list[dict]] = _persisted.get("by_path", {})
_meta: dict[str, dict] = _persisted.get("meta", {})
_last_post: dict[str, float] = {}
_subscribers: set[asyncio.Queue] = set()


def _persist():
    statefile.save(_STATE, {"by_path": _by_path, "meta": _meta})


def _publish(event: dict):
    payload = json.dumps(event)
    for queue in list(_subscribers):
        try:
            queue.put_nowait(payload)
        except asyncio.QueueFull:
            pass            # a wedged reader loses frames, never blocks a writer


def _open(path: str) -> list[dict]:
    """Comments still on the page. A dismissed comment is archived, not deleted,
    so it can come back; it no longer counts toward the cap or shows anywhere."""
    return [c for c in _by_path.get(path, []) if not c.get("archived")]


def _find(path: str, comment_id):
    if not comment_id:
        return None
    return next((c for c in _by_path.get(path, []) if c["id"] == comment_id), None)


def _text(value) -> str:
    return value if isinstance(value, str) else ("" if value is None else str(value))


def _clean_path(value) -> str:
    path = _text(value).strip().lstrip("/")
    if not path:
        raise HTTPException(status_code=400, detail="path is required")
    return path


@router.post("/api/comments")
async def post_comment(body: dict):
    path = _clean_path(body.get("path"))
    text = _text(body.get("text")).strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    author = _text(body.get("author")).lower() or "rodin"
    if author not in AUTHORS:
        raise HTTPException(status_code=400, detail="author must be jean or rodin")

    now = time.monotonic()
    # The pace limit is there for a model that can post in a loop, not for a person.
    if author == "rodin" and MIN_INTERVAL_S and now - _last_post.get(path, 0.0) < MIN_INTERVAL_S:
        raise HTTPException(status_code=429, detail="commenting too fast for this document")

    if len(_open(path)) >= PER_DOC_CAP:
        raise HTTPException(status_code=429, detail="too many open comments on this document")

    line = body.get("line")
    try:
        line = int(line) if line is not None else None
    except (TypeError, ValueError):
        line = None
    if line is not None and line < 1:
        line = 1

    comment = {
        "id": uuid.uuid4().hex[:12],
        "path": path,
        "author": author,
        "text": text[:TEXT_CAP],
        "quote": _text(body.get("quote"))[:TEXT_CAP] or None,
        "line": line,
        "kind": (_text(body.get("kind")) or "note")[:32],
        "at": time.time(),
        "replies": [],
    }
    if comment["quote"] is None and comment["line"] is None:
        raise HTTPException(status_code=400, detail="a comment needs a quote or a line to anchor to")

    _by_path.setdefault(path, []).append(comment)
    if author == "rodin":
        _last_post[path] = now
    _persist()
    _publish({"type": "comment", "comment": comment})
    if author == "jean":
        asyncio.get_running_loop().run_in_executor(None, _tell_rodin, _comment_message(path, comment))
    return {"ok": True, "id": comment["id"]}


@router.post("/api/comments/meta")
async def post_meta(body: dict):
    path = _clean_path(body.get("path"))
    meta = _meta.setdefault(path, {"thinking": "", "summary": ""})
    if "thinking" in body:
        meta["thinking"] = _text(body.get("thinking"))[:TEXT_CAP]
    if "summary" in body:
        meta["summary"] = _text(body.get("summary"))[:TEXT_CAP]
    meta["at"] = time.time()
    _persist()
    _publish({"type": "meta", "path": path, "meta": meta})
    return {"ok": True}


@router.post("/api/comments/resolve")
async def resolve(body: dict):
    """Dismiss a comment, or with no id every comment on the document. Archives
    rather than deletes: the comment leaves the page and the counts, and
    /api/comments/restore brings it back."""
    path = _clean_path(body.get("path"))
    comment_id = body.get("id")
    targets = _open(path) if comment_id is None else [c for c in _open(path) if c["id"] == comment_id]
    for comment in targets:
        comment["archived"] = True
        comment["archived_at"] = time.time()
    if comment_id is None:
        _meta.pop(path, None)
    _persist()
    _publish({"type": "resolve", "path": path, "id": comment_id})
    return {"ok": True, "removed": len(targets)}


@router.post("/api/comments/restore")
async def restore(body: dict):
    path = _clean_path(body.get("path"))
    comment = _find(path, body.get("id"))
    if comment is None:
        raise HTTPException(status_code=404, detail="no such comment")
    comment.pop("archived", None)
    comment.pop("archived_at", None)
    _persist()
    _publish({"type": "comment", "comment": comment, "restored": True})
    return {"ok": True}


def _reply_instructions(path: str, comment: dict) -> list[str]:
    """How Rodin answers: the curl is quoted for the shell, because the path and
    id are interpolated into a command he is told to run."""
    payload = json.dumps({"path": path, "id": comment["id"], "text": "<your reply>", "author": "rodin"})
    bearer = ""
    if auth.enabled():
        source = f"$(cat {auth.TOKEN_FILE})" if auth.TOKEN_FILE.is_file() else "$WRITER_TOKEN"
        bearer = f' -H "Authorization: Bearer {source}"'
    return ["", "Answer in the thread, not in chat. Post your reply with:",
            f'curl -s -X POST {REPLY_URL} -H "Content-Type: application/json"{bearer} -d {shlex.quote(payload)}']


def _quoted_span(comment: dict) -> list[str]:
    return [f'The text the comment is on: "{comment["quote"][:300]}"'] if comment.get("quote") else []


def _thread_message(path: str, comment: dict, reply: dict) -> str:
    lines = [f'Jean replied in the comment thread on "{path}".', "", *_quoted_span(comment)]
    lines.append(f'{"Jean" if comment["author"] == "jean" else "Rodin"}: {comment["text"]}')
    for earlier in comment.get("replies", [])[:-1]:
        lines.append(f'{"Jean" if earlier["author"] == "jean" else "Rodin"}: {earlier["text"]}')
    lines.append(f'Jean: {reply["text"]}')
    return "\n".join(lines + _reply_instructions(path, comment))


def _comment_message(path: str, comment: dict) -> str:
    lines = [f'Jean left an inline comment on "{path}".', "", *_quoted_span(comment),
             f'Jean: {comment["text"]}']
    return "\n".join(lines + _reply_instructions(path, comment))


def _tell_rodin(message: str):
    """Hand something Jean wrote in a comment (a reply, or a comment of his own)
    to Rodin through the same inject webhook active listening uses, off the
    request path so a slow relayd cannot slow the post. It is addressed to
    Rodin, so it is sent whether or not listening is on."""
    from . import listening
    try:
        ok, error = listening._inject(message)
        if not ok:
            log.warning("could not tell Rodin about a thread reply: %s", error)
    except Exception:
        log.exception("could not tell Rodin about a thread reply")


@router.post("/api/comments/reply")
async def reply(body: dict):
    path = _clean_path(body.get("path"))
    comment = _find(path, body.get("id"))
    if comment is None or comment.get("archived"):
        raise HTTPException(status_code=404, detail="no such open comment")
    text = _text(body.get("text")).strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    author = _text(body.get("author")).lower() or "jean"
    if author not in AUTHORS:
        raise HTTPException(status_code=400, detail="author must be jean or rodin")
    thread = comment.setdefault("replies", [])
    if len(thread) >= REPLY_CAP:
        raise HTTPException(status_code=429, detail="this thread is full")
    entry = {"id": uuid.uuid4().hex[:12], "author": author, "text": text[:TEXT_CAP], "at": time.time()}
    thread.append(entry)
    _persist()
    _publish({"type": "reply", "path": path, "id": comment["id"], "reply": entry})
    if author == "jean":
        asyncio.get_running_loop().run_in_executor(None, _tell_rodin, _thread_message(path, comment, entry))
    return {"ok": True, "id": entry["id"]}


@router.get("/api/comments")
async def list_comments(path: str, archived: int = 0):
    path = _clean_path(path)
    if archived:
        return {"comments": [c for c in _by_path.get(path, []) if c.get("archived")], "meta": {}}
    return {"comments": _open(path), "meta": _meta.get(path, {})}


@router.get("/api/comments/stream")
async def stream(request: Request):
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    _subscribers.add(queue)

    async def gen():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    yield f"data: {await asyncio.wait_for(queue.get(), timeout=20)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            _subscribers.discard(queue)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


registry.route(router)
