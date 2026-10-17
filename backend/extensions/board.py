"""Board mode: a live blackboard beside a document, drawn on by the assistant.

A board is a list of drawing steps (ops), and it only grows, the way chalk goes
on a real board. Placement is semantic: a node names its rank (row) and order
(position in the row), never pixels, so the browser relays it out at any width.

Why every batch is checked here rather than in the renderer. The assistant
draws through tools, and a bad op that reaches the page fails silently: an
arrow to a node that is not there draws nothing, a label too long for its box
spills over its neighbour. Refusing the whole batch with a message that names
the op and the reason turns that into an error the assistant reads and fixes.

Undo removes the most recent batch, so a bad drawing comes off without wiping
the board. Clear is the owner's: see clear() for what that does and does not
guarantee.

Persisted through statefile, off the writing path, like comments.
"""
from __future__ import annotations

import asyncio
import html
import json
import logging
import os
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse

from vfs import norm

from . import registry, statefile

log = logging.getLogger("vessel-writer.board")

OP_CAP = int(os.environ.get("BOARD_OP_CAP", "400"))
LABEL_CAP = 28
SUB_CAP = 32
NOTE_CAP = 90
BATCH_LABEL_CAP = 60
ID_CAP = 40
RANK_MAX = 30
STEP_MAX = 99

NODE_KINDS = ("actor", "service", "state", "boundary")
# Friendlier spellings the assistant will reach for, folded onto the four kinds.
NODE_KIND_ALIASES = {"attacker": "actor", "data": "state", "zone": "boundary"}
LINK_KINDS = ("state", "peer", "attempt", "failed")
ZONE_KINDS = ("segment", "trust", "container")

# Which fields each op may carry, and which it must. Anything else is refused:
# a misspelt field ("lable") silently dropped is a label that never appears.
FIELDS = {
    "node": ({"id", "label"}, {"sub", "rank", "order", "kind", "zone"}),
    "link": ({"from", "to"}, {"label", "kind", "step"}),
    "note": ({"text"}, {"rank"}),
    "emphasize": ({"ids"}, set()),
    "zone": ({"id", "label"}, {"ids", "kind"}),
}

STATIC = Path(__file__).resolve().parent.parent.parent / "static"
THEMES = ("light", "sepia", "dark", "night", "nord", "gruvbox", "forest", "rose", "solarized")

router = APIRouter()

_STATE = "boards"
_boards: dict[str, dict] = statefile.load(_STATE, {}).get("by_path", {})
_subscribers: set[asyncio.Queue] = set()


def _persist():
    statefile.save(_STATE, {"by_path": _boards})


def _publish(event: dict):
    payload = json.dumps(event)
    for queue in list(_subscribers):
        try:
            queue.put_nowait(payload)
        except asyncio.QueueFull:
            pass            # a wedged reader loses frames, never blocks a writer


def _clean_path(value) -> str:
    path = norm(value) if isinstance(value, str) else ""
    if not path:
        raise HTTPException(status_code=400, detail="path is required")
    return path


def _board(path: str) -> dict:
    return _boards.get(path) or {"ops": [], "next_seq": 1}


class Refused(Exception):
    pass


def _text(op: dict, field: str, cap: int, where: str, required: bool) -> str | None:
    value = op.get(field)
    if value is None:
        if required:
            raise Refused(f"{where}: {field} is required")
        return None
    if not isinstance(value, str):
        raise Refused(f"{where}: {field} must be text")
    value = " ".join(value.split())
    if required and not value:
        raise Refused(f"{where}: {field} is empty")
    if len(value) > cap:
        raise Refused(f"{where}: {field} is {len(value)} characters, over the {cap} that fit; "
                      f"shorten {value!r}")
    return value or None


def _int(op: dict, field: str, lo: int, hi: int, where: str, default=None):
    value = op.get(field, default)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value):
        raise Refused(f"{where}: {field} must be a whole number")
    if not lo <= value <= hi:
        raise Refused(f"{where}: {field} must be between {lo} and {hi}, got {int(value)}")
    return int(value)


def _ident(op: dict, field: str, where: str) -> str:
    value = _text(op, field, ID_CAP, where, required=True)
    if any(c.isspace() for c in value):
        raise Refused(f"{where}: {field} {value!r} may not contain spaces")
    return value


def _ids(op: dict, where: str, nodes: set[str], required: bool) -> list[str]:
    value = op.get("ids", None if required else [])
    if not isinstance(value, list) or not all(isinstance(i, str) for i in value):
        raise Refused(f"{where}: ids must be a list of node ids")
    for node_id in value:
        if node_id not in nodes:
            raise Refused(f"{where}: {node_id!r} is not a node on the board or earlier in this batch")
    return list(dict.fromkeys(value))


def _kind(op: dict, where: str, kinds: tuple, aliases: dict | None = None) -> str | None:
    value = op.get("kind")
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise Refused(f"{where}: kind must be text")
    value = (aliases or {}).get(value, value)
    if value not in kinds:
        raise Refused(f"{where}: kind {op.get('kind')!r} is not one of {', '.join(kinds)}")
    return value


def validate(existing: list[dict], ops) -> list[dict]:
    """The batch as it will be stored, or Refused naming the first bad op.
    References may point at the board or at ops earlier in the same batch."""
    if not isinstance(ops, list) or not ops:
        raise Refused("ops must be a non-empty list")
    if len(existing) + len(ops) > OP_CAP:
        raise Refused(f"this board holds {len(existing)} ops and the cap is {OP_CAP}; "
                      f"{len(ops)} more will not fit. Undo or start a new document's board")

    nodes = {o["id"] for o in existing if o["op"] == "node"}
    zones = {o["id"] for o in existing if o["op"] == "zone"}
    zoned = {n for o in existing if o["op"] == "zone" for n in o.get("ids", [])}
    zoned |= {o["id"] for o in existing if o["op"] == "node" and o.get("zone")}

    out = []
    for n, op in enumerate(ops, 1):
        if not isinstance(op, dict):
            raise Refused(f"op {n}: must be an object")
        kind = op.get("op")
        if kind not in FIELDS:
            raise Refused(f"op {n}: unknown op {kind!r}; use one of {', '.join(FIELDS)}")
        where = f"op {n} ({kind})"
        required, optional = FIELDS[kind]
        extra = set(op) - required - optional - {"op"}
        if extra:
            raise Refused(f"{where}: unknown field {', '.join(sorted(extra))}; "
                          f"a {kind} takes {', '.join(sorted(required | optional))}")

        clean: dict = {"op": kind}
        if kind == "node":
            node_id = _ident(op, "id", where)
            if node_id in nodes:
                raise Refused(f"{where}: a node with id {node_id!r} is already on the board")
            if node_id in zones:
                raise Refused(f"{where}: {node_id!r} is already a zone's id")
            clean.update(id=node_id, label=_text(op, "label", LABEL_CAP, where, True),
                         sub=_text(op, "sub", SUB_CAP, where, False),
                         rank=_int(op, "rank", 0, RANK_MAX, where, 0),
                         order=_int(op, "order", -1000, 1000, where, 0),
                         kind=_kind(op, where, NODE_KINDS, NODE_KIND_ALIASES))
            zone = op.get("zone")
            if zone is not None:
                if zone not in zones:
                    raise Refused(f"{where}: zone {zone!r} is not on the board or earlier in this batch")
                clean["zone"] = zone
                zoned.add(node_id)
            nodes.add(node_id)
        elif kind == "link":
            ends = []
            for end in ("from", "to"):
                ref = op.get(end)
                if ref not in nodes:
                    raise Refused(f"{where}: {end} {ref!r} is not a node on the board or earlier in this batch")
                ends.append(ref)
            if ends[0] == ends[1]:
                raise Refused(f"{where}: a link needs two different nodes, got {ends[0]!r} twice")
            clean.update({"from": ends[0], "to": ends[1]},
                         label=_text(op, "label", LABEL_CAP, where, False),
                         kind=_kind(op, where, LINK_KINDS),
                         step=_int(op, "step", 1, STEP_MAX, where))
        elif kind == "note":
            clean.update(text=_text(op, "text", NOTE_CAP, where, True),
                         rank=_int(op, "rank", 0, RANK_MAX, where, 0))
        elif kind == "emphasize":
            clean["ids"] = _ids(op, where, nodes, required=True)
        elif kind == "zone":
            zone_id = _ident(op, "id", where)
            if zone_id in zones:
                raise Refused(f"{where}: a zone with id {zone_id!r} is already on the board")
            if zone_id in nodes:
                raise Refused(f"{where}: {zone_id!r} is already a node's id")
            members = _ids(op, where, nodes, required=False)
            for member in members:
                if member in zoned:
                    raise Refused(f"{where}: node {member!r} is already in a zone; a node sits in one zone")
            zoned.update(members)
            zones.add(zone_id)
            clean.update(id=zone_id, label=_text(op, "label", LABEL_CAP, where, True),
                         ids=members, kind=_kind(op, where, ZONE_KINDS))
        out.append({k: v for k, v in clean.items() if v is not None})
    return out


@router.get("/api/board")
async def get_board(path: str):
    path = _clean_path(path)
    board = _board(path)
    return {"path": path, "ops": board["ops"], "count": len(board["ops"]), "cap": OP_CAP}


@router.post("/api/board/append")
async def append(body: dict):
    path = _clean_path(body.get("path"))
    board = _board(path)
    label = body.get("batch")
    if label is not None and (not isinstance(label, str) or len(label) > BATCH_LABEL_CAP):
        raise HTTPException(400, f"batch, when given, is a label of at most {BATCH_LABEL_CAP} characters")
    try:
        ops = validate(board["ops"], body.get("ops"))
    except Refused as exc:
        status = 429 if "the cap is" in str(exc) else 400
        raise HTTPException(status, f"nothing was drawn: {exc}")
    batch = uuid.uuid4().hex[:12]
    at = time.time()
    first = board["next_seq"]
    for i, op in enumerate(ops):
        op.update(seq=first + i, batch=batch, at=at)
        if label:
            op["batch_label"] = label
    board["ops"] = board["ops"] + ops
    board["next_seq"] = first + len(ops)
    _boards[path] = board
    _persist()
    _publish({"type": "append", "path": path, "batch": batch, "ops": ops})
    return {"ok": True, "path": path, "batch": batch, "seqs": [op["seq"] for op in ops],
            "count": len(board["ops"]), "cap": OP_CAP}


@router.post("/api/board/undo")
async def undo(body: dict):
    """Take off the most recent batch, and only that one. Seq numbers are never
    reused, so a page that has seen a seq can always tell it is gone."""
    path = _clean_path(body.get("path"))
    board = _board(path)
    if not board["ops"]:
        raise HTTPException(404, "the board is empty; nothing to undo")
    batch = board["ops"][-1]["batch"]
    kept = [op for op in board["ops"] if op["batch"] != batch]
    removed = len(board["ops"]) - len(kept)
    board["ops"] = kept
    _boards[path] = board
    _persist()
    _publish({"type": "undo", "path": path, "batch": batch})
    return {"ok": True, "path": path, "batch": batch, "removed": removed, "count": len(kept)}


@router.post("/api/board/clear")
async def clear(body: dict, request: Request):
    """Wipe a board. Only the owner's page calls this, and it is not an MCP tool.

    What separates the owner from the assistant here is the channel, not a
    secret: the browser holds a session cookie and the assistant's tools send a
    bearer token. Both come from the one owner token, so anyone holding the
    token could mint the cookie, and with auth off there is neither. So this is
    a guard against accidents, not an access boundary: a bearer call is turned
    away, and every call must say {"confirm": true}."""
    if request.headers.get("authorization", "").lower().startswith("bearer "):
        raise HTTPException(403, "clearing a board is the owner's to do, from the board pane; "
                                 "to take off your own drawing, use undo")
    if body.get("confirm") is not True:
        raise HTTPException(400, 'clearing a board needs {"confirm": true}')
    path = _clean_path(body.get("path"))
    board = _board(path)
    removed = len(board["ops"])
    board["ops"] = []
    _boards[path] = board
    _persist()
    _publish({"type": "clear", "path": path})
    return {"ok": True, "path": path, "removed": removed}


@router.get("/api/board/stream")
async def stream(request: Request):
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    _subscribers.add(queue)

    async def gen():
        try:
            yield ": connected\n\n"
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
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/board-render")
async def render(path: str, theme: str = "light"):
    """Just the board for one document, for the snapshot tool to load in a
    headless browser. Behind the same login as everything else: the auth
    middleware sees every route, this one included."""
    path = _clean_path(path)
    if theme not in THEMES:
        raise HTTPException(400, f"theme must be one of {', '.join(THEMES)}")
    page = (STATIC / "board-render.html").read_text()
    page = page.replace("{{theme}}", theme)
    page = page.replace("/*{{path}}*/null", json.dumps(path).replace("</", "<\\/"))
    page = page.replace("{{title}}", html.escape(path))
    return HTMLResponse(page)


def _on_move(vfs=None, old=None, new=None, **_):
    if old in _boards:
        _boards[new] = _boards.pop(old)
        _persist()
        _publish({"type": "moved", "old": old, "path": new})


def _on_purge(vfs=None, path=None, **_):
    if _boards.pop(path, None) is not None:
        _persist()


registry.on("on_move", _on_move)
registry.on("on_purge", _on_purge)
registry.route(router)
