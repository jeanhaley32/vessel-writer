"""vessel-writer backend.

A tiny FastAPI app: serves the distraction-free editor SPA and a small JSON API
over the virtual filesystem / blob store. Deliberately a thin core so features
bolt on as extensions (see extensions/) without touching this file.

Run:  WRITER_ROOT=~/vessel-log/writing uvicorn app:app --host 127.0.0.1 --port 8791
"""
from __future__ import annotations

import asyncio
import base64
import datetime
import difflib
import json
import logging
import os
import secrets
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.routing import Match
from pydantic import BaseModel
from pycrdt import Doc, Text

import auth
from vfs import VFS, norm as _norm
from extensions import registry
from extensions import ingestion

log = logging.getLogger("vessel-writer")
ROOT = Path(os.path.expanduser(os.environ.get("WRITER_ROOT", "~/vessel-log/writing")))
STATIC = Path(__file__).resolve().parent.parent / "static"

auth.check_bind(os.environ.get("WRITER_HOST", "127.0.0.1"))
vfs = VFS(ROOT)
app = FastAPI(title="vessel-writer")
app.add_middleware(auth.AuthMiddleware)
app.include_router(auth.router)

# NOTE: a CacheControlMiddleware was tried here to force revalidation of the
# module chain, but it broke the page load in the browser (empty tree, editor
# never mounted) even though curl saw 200s — removed. StaticFiles' built-in
# ETag/Last-Modified revalidation is sufficient; if mobile staleness recurs,
# handle it with per-URL versioning (?v=), not a broad response middleware.


class SaveBody(BaseModel):
    path: str
    content: str
    title: str | None = None
    # An editor tab in a live session sets collab + session: the server's copy of
    # the shared document is then the truth and `content` is not applied. Any
    # other writer (Rodin, scripts) sets external: its content is merged into the
    # live session as an edit, so open tabs see it instead of overwriting it.
    collab: bool = False
    session: str | None = None
    external: bool = False


class MoveBody(BaseModel):
    old: str
    new: str


class PathBody(BaseModel):
    path: str


class RmdirBody(BaseModel):
    path: str
    recursive: bool = False


@app.get("/api/tree")
def tree():
    return {"documents": vfs.tree()}


@app.get("/api/structure")
def structure():
    return vfs.structure()


@app.post("/api/mkdir")
def mkdir(body: PathBody):
    try:
        return vfs.mkdir(body.path)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/rmdir")
def rmdir(body: RmdirBody):
    try:
        res = vfs.rmdir(body.path, body.recursive)
    except ValueError as e:
        raise HTTPException(409, str(e))
    for d in res.get("deleted_docs", []):
        registry.fire("on_delete", vfs=vfs, path=d)
    return res


@app.get("/api/doc")
async def get_doc(path: str, collab: bool = False):
    doc = vfs.read(path)
    if doc is None:
        raise HTTPException(404, "not found")
    if collab:
        session = _session(doc["path"], doc["content"])
        doc["content"] = _session_text(session)
        doc["yseed"] = session["seed"]
        doc["ysession"] = session["id"]
        # The session's own Yjs client writes every non-tab edit (the
        # assistant's), so a tab can attribute text by client id.
        doc["ywriter"] = session["doc"].client_id
    return doc


@app.put("/api/doc")
async def put_doc(body: SaveBody):
    session = _ysessions.get(_norm(body.path))
    content = body.content
    if session is not None:
        if body.collab and body.session == session["id"]:
            content = _session_text(session)
        elif body.external:
            _merge_external(session, body.content)
        else:
            # An editor tab from before live sessions existed, or one whose
            # session ended (server restart). Its copy can be stale, so it must
            # reload rather than write over the live document.
            raise HTTPException(409, "document has a live session; reload the editor")
    return _store(body.path, content, body.title)


def _store(path: str, content: str, title: str | None = None) -> dict:
    try:
        res = vfs.save(path, content, title)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if res.get("revived"):
        registry.fire("on_undelete", vfs=vfs, path=res["path"])
    # extension hook: fire only when a NEW 30s version slot opens — not on the
    # frequent intra-slot autosaves — so ingestion embeds ~once per version, not
    # once per keystroke-pause.
    if res.get("new_version"):
        registry.fire("on_save", vfs=vfs, path=res["path"], hash=res["hash"])
    if res.get("changed"):
        registry.fire("on_change", vfs=vfs, path=res["path"], hash=res["hash"])
    return res


# --- Anchored edits -----------------------------------------------------------
# How a collaborator who is not an editor tab (Rodin, a script) writes into a
# document: "insert this after X", "replace X with Y", "append this". Each edit
# is located by quoting text that is in the document now, at the moment it is
# applied, so it touches only its own span and can never write back a stale
# copy over what the owner typed meanwhile. An anchor that is missing or
# ambiguous refuses the whole request rather than guessing.

class EditOp(BaseModel):
    op: str                      # insert_after | insert_before | replace | append
    text: str
    anchor: str | None = None


class EditBody(BaseModel):
    path: str
    ops: list[EditOp]


def _apply_ops(content: str, ops: list[EditOp]) -> tuple[str, list[tuple[int, int, str]]]:
    """The edited text, and the (at, delete, insert) splices that produce it."""
    splices = []
    for n, op in enumerate(ops, 1):
        if op.op == "append":
            joiner = "" if not content or content.endswith("\n") else "\n"
            splice = (len(content), 0, joiner + op.text)
        else:
            if op.op not in ("insert_after", "insert_before", "replace"):
                raise HTTPException(400, f"edit {n}: unknown op {op.op!r}")
            if not op.anchor:
                raise HTTPException(400, f"edit {n}: {op.op} needs an anchor")
            count = content.count(op.anchor)
            if count != 1:
                reason = "is not in the document" if count == 0 else f"appears {count} times; quote more of it"
                raise HTTPException(409, f"edit {n}: the anchor {reason}")
            if op.op == "replace" and len(op.anchor) == len(content):
                raise HTTPException(400, f"edit {n}: an edit may not replace the whole document")
            at = content.index(op.anchor)
            splice = {"insert_before": (at, 0, op.text),
                      "insert_after": (at + len(op.anchor), 0, op.text),
                      "replace": (at, len(op.anchor), op.text)}[op.op]
        at, delete, insert = splice
        content = content[:at] + insert + content[at + delete:]
        splices.append(splice)
    return content, splices


@app.post("/api/doc/edit")
async def edit_doc(body: EditBody):
    if not body.ops:
        raise HTTPException(400, "no edits given")
    path = _norm(body.path)
    doc = vfs.read(path)
    if doc is None or path in {t["path"] for t in vfs.tombstones()}:
        raise HTTPException(404, "not found")
    session = _ysessions.get(path)
    # No await between reading the live text and merging into it, so no tab's
    # update can land in between: the edits apply to exactly this text.
    current = _session_text(session) if session is not None else doc["content"]
    updated, splices = _apply_ops(current, body.ops)
    if session is not None:
        _apply_splices(session, splices)
    res = _store(path, updated)
    # Tell listeners which text is the assistant's: anything that keeps a
    # baseline of "what the owner has written" applies the same edits to it,
    # so the assistant's own words are never reported back to it as his.
    registry.fire("on_assistant_edit", path=path, rebase=lambda text: _apply_ops(text, body.ops)[0])
    return {**res, "applied": len(body.ops)}


@app.post("/api/reconcile")
def reconcile():
    return ingestion.reconcile(vfs)


@app.post("/api/move")
async def move(body: MoveBody):
    try:
        res = vfs.move(body.old, body.new)
    except ValueError as e:
        raise HTTPException(409, str(e))
    for old_p, _ in res.get("moved_docs", []):
        _end_session(old_p)
    # keep recall paths in sync with renames/moves
    for old_p, new_p in res.get("moved_docs", []):
        registry.fire("on_move", vfs=vfs, old=old_p, new=new_p)
    return res


@app.post("/api/delete")
async def delete(body: PathBody):
    res = vfs.delete(body.path)
    _end_session(res["deleted"])
    # tombstone marker propagates to recall so deleted writing stops surfacing
    registry.fire("on_delete", vfs=vfs, path=res["deleted"])
    return res


@app.post("/api/undelete")
def undelete(body: PathBody):
    res = vfs.undelete(body.path)
    registry.fire("on_undelete", vfs=vfs, path=body.path)
    return res


@app.post("/api/reap")
def reap(grace_days: float = 7):
    """Physically purge docs tombstoned longer than grace_days: PG + Qdrant
    (via the on_purge hook) then the VFS row/versions/blobs. Runs server-side so
    the app stays the single owner of the SQLite index."""
    older = grace_days * 86400
    purged = []
    for t in vfs.tombstones(older_than_s=older):
        registry.fire("on_purge", vfs=vfs, path=t["path"])  # ingestion clears PG + Qdrant
        vfs.purge(t["path"])
        purged.append(t["path"])
    return {"grace_days": grace_days, "purged": purged, "count": len(purged)}


@app.get("/api/history")
def history(path: str):
    return {"versions": vfs.history(path)}


@app.get("/api/version")
def version(path: str, hash: str):
    content = vfs.version_content(path, hash)
    if content is None:
        raise HTTPException(404, "no such version for this document")
    return {"path": path, "hash": hash, "content": content}


@app.post("/api/restore")
async def restore(path: str, hash: str):
    res = vfs.restore(path, hash)
    if res is None:
        raise HTTPException(404, "no such version for this document")
    session = _ysessions.get(res["path"])
    if session is not None:
        _merge_external(session, vfs.read(res["path"])["content"])
    # restoring changes the current text -> a new version slot -> re-ingest for recall
    if res.get("new_version"):
        registry.fire("on_save", vfs=vfs, path=res["path"], hash=res["hash"])
    return res


# --- Live co-editing ------------------------------------------------------
# Each open document has one live session: a server-side Yjs document that
# every editor tab joins. The server seeds it once from the saved text, hands
# that exact seed to every tab, and applies every tab's update to its own copy,
# so its copy is always the current shared text. That is what lets a writer
# that is not an editor tab (Rodin, a script, a restore) change an open
# document safely: the change is merged in as an edit by its own Yjs client and
# broadcast, instead of being written underneath the tabs.
#
# Sessions live in memory. A restart ends them; tabs notice the new session id
# on reconnect and reload.
_ysessions: dict[str, dict] = {}                   # path -> {"id", "doc", "seed"}
_ysubs: dict[str, set[asyncio.Queue]] = {}         # path -> set of subscriber queues
SYNC_PROTOCOL = 2


def _session(path: str, content: str) -> dict:
    session = _ysessions.get(path)
    if session is not None:
        return session
    seeder = Doc(client_id=secrets.randbits(30) + 1)
    if content:
        seeder.get("content", type=Text).insert(0, content)
    seed = seeder.get_update()
    doc = Doc(client_id=secrets.randbits(30) + 1)
    doc.apply_update(seed)
    session = {"id": secrets.token_hex(8), "doc": doc, "seed": base64.b64encode(seed).decode()}
    _ysessions[path] = session
    return session


def _session_text(session: dict) -> str:
    return str(session["doc"].get("content", type=Text))


def _merge_external(session: dict, new: str) -> None:
    """Turn a whole-text write into a minimal Yjs edit and send it to the tabs."""
    old = _session_text(session)
    if old == new:
        return
    ops = difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes()
    # Back to front, so each splice's position is still an offset into `old`.
    _apply_splices(session, [(i1, i2 - i1, new[j1:j2])
                             for tag, i1, i2, j1, j2 in reversed(ops) if tag != "equal"])


def _apply_splices(session: dict, splices: list[tuple[int, int, str]]) -> None:
    """Apply (at, delete, insert) splices, each positioned in the text as the
    ones before it left it, as one Yjs transaction by the session's own client,
    then broadcast it and show Rodin's cursor after the last one. That client is
    how a tab attributes text to Rodin, so the splices must be exactly the
    edit: an anchored insert goes in as itself, never as an equivalent diff
    that would shift which characters count as his. pycrdt indexes text by
    UTF-8 byte, so character offsets are converted."""
    if not splices:
        return
    doc = session["doc"]
    text = doc.get("content", type=Text)
    before = doc.get_state()
    with doc.transaction():
        for at, delete, insert in splices:
            current = str(text)
            start = len(current[:at].encode())
            if delete:
                del text[start:len(current[:at + delete].encode())]
            if insert:
                text.insert(start, insert)
    path = next(p for p, s in _ysessions.items() if s is session)
    _broadcast(path, base64.b64encode(doc.get_update(before)).decode())
    at, _, insert = splices[-1]
    try:
        _show_cursor(path, session, len(str(text)[:at + len(insert)].encode()))
    except Exception:
        # presence is a nicety; it must never fail the write it decorates
        log.exception("could not place Rodin's cursor in %s", path)


# Rodin has no editor tab, so it publishes its own presence: a named cursor at
# the end of its latest edit, withdrawn a few seconds later. The wire format is
# y-protocols awareness: count, then per client (id, clock, JSON state).
RODIN_USER = {"name": "Rodin", "color": "#b8561f", "colorLight": "#b8561f33"}
CURSOR_LINGER_S = 6.0


def _var_uint(n: int) -> bytes:
    out = bytearray()
    while n > 0x7F:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)
    return bytes(out)


def _awareness_update(client_id: int, clock: int, state) -> str:
    payload = json.dumps(state).encode()
    raw = _var_uint(1) + _var_uint(client_id) + _var_uint(clock) + _var_uint(len(payload)) + payload
    return base64.b64encode(raw).decode()


def _show_cursor(path: str, session: dict, byte_index: int) -> None:
    doc = session["doc"]
    text = doc.get("content", type=Text)
    # pycrdt panics on an index at the very end of the text, which is where an
    # append lands, so anchor to the last character instead.
    size = len(str(text).encode())
    if size == 0:
        return
    position = text.sticky_index(min(byte_index, size - 1)).to_json()
    session["aclock"] = session.get("aclock", 0) + 1
    state = {"user": RODIN_USER, "cursor": {"anchor": position, "head": position}}
    _broadcast(path, "a:" + _awareness_update(doc.client_id, session["aclock"], state))
    clock = session["aclock"]

    def withdraw():
        if session.get("aclock") == clock and _ysessions.get(path) is session:
            session["aclock"] = clock + 1
            _broadcast(path, "a:" + _awareness_update(doc.client_id, clock + 1, None))

    asyncio.get_running_loop().call_later(CURSOR_LINGER_S, withdraw)


def _broadcast(path: str, message: str) -> None:
    for q in list(_ysubs.get(path, ())):
        try:
            q.put_nowait(message)
        except asyncio.QueueFull:
            pass


def _end_session(path: str) -> None:
    if _ysessions.pop(_norm(path), None) is not None:
        _broadcast(_norm(path), "s:ended")


class YUpdateBody(BaseModel):
    path: str
    update: str   # base64-encoded Yjs update
    v: int = 1


@app.post("/api/yupdate")
async def yupdate(body: YUpdateBody):
    session = _ysessions.get(_norm(body.path))
    if body.v < SYNC_PROTOCOL or session is None:
        # An outdated tab seeds itself differently from the session, so its
        # updates would duplicate text. Drop them; its saves get a 409.
        return {"ok": False, "reason": "reload the editor"}
    try:
        session["doc"].apply_update(base64.b64decode(body.update, validate=True))
    except Exception:
        raise HTTPException(400, "update must be a base64 Yjs update")
    _broadcast(_norm(body.path), body.update)
    return {"ok": True}


@app.post("/api/awareness")
async def awareness(body: YUpdateBody):
    """Relay an ephemeral awareness (cursor/selection/presence) update to peers.
    Tagged 'a:' on the shared sync stream and never stored."""
    try:
        base64.b64decode(body.update, validate=True)
    except Exception:
        raise HTTPException(400, "update must be base64")
    _broadcast(_norm(body.path), "a:" + body.update)
    return {"ok": True}


@app.get("/api/ystate")
def ystate(path: str):
    """Whether a doc has a live session, and its current shared text length."""
    session = _ysessions.get(_norm(path))
    return {"live": session is not None, "session": session and session["id"],
            "length": session and len(_session_text(session))}


@app.get("/api/ysync")
async def ysync(path: str, request: Request, v: int = 1):
    """SSE: announce the session id, send the full current state, then stream
    every new update. 's:'-tagged events carry the session id, 'a:' awareness."""
    path = _norm(path)
    q: asyncio.Queue = asyncio.Queue(maxsize=1024)
    _ysubs.setdefault(path, set()).add(q)
    session = _ysessions.get(path)

    async def gen():
        try:
            yield ": connected\n\n"
            if v >= SYNC_PROTOCOL:
                yield f"data: s:{session['id'] if session else 'none'}\n\n"
                if session is not None:
                    yield f"data: {base64.b64encode(session['doc'].get_update()).decode()}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    u = await asyncio.wait_for(q.get(), timeout=25)
                    if v >= SYNC_PROTOCOL:     # an outdated tab can't apply session updates safely
                        yield f"data: {u}\n\n"
                except asyncio.TimeoutError:
                    yield ": ka\n\n"      # keepalive
        finally:
            subscribers = _ysubs.get(path)
            if subscribers is not None:
                subscribers.discard(q)
                if not subscribers:
                    del _ysubs[path]

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


_CLIENTLOG = Path(os.path.expanduser(os.environ.get("WRITER_CLIENTLOG", "~/vessel-writer/client.log")))
_CLIENTLOG_MAX_BYTES = 2 * 1024 * 1024


class ClientLogBody(BaseModel):
    level: str = "info"
    msg: str = ""


def _one_line(text: str, limit: int) -> str:
    """A client-supplied string on a single log line: a newline in it must not
    be able to start what looks like another entry."""
    return " ".join(text.split())[:limit]


@app.post("/api/clientlog")
async def clientlog(body: ClientLogBody):
    """Capture client-side errors/events (window.onerror, editor lifecycle) to a
    server log so the writer is actually troubleshootable without the browser
    console. Best-effort, single-line entries, and the file stops growing at
    _CLIENTLOG_MAX_BYTES."""
    try:
        if _CLIENTLOG.exists() and _CLIENTLOG.stat().st_size >= _CLIENTLOG_MAX_BYTES:
            return {"ok": False}
        stamp = datetime.datetime.now().isoformat(timespec="seconds")
        with open(_CLIENTLOG, "a") as f:
            f.write(f"{stamp} [{_one_line(body.level, 12)}] {_one_line(body.msg, 1800)}\n")
    except OSError:
        log.warning("could not write the client log", exc_info=True)
    return {"ok": True}


# There is no raw terminal stream in the writer. `/api/insight` used to
# screen-scrape the session's tmux pane here, which carried command output and
# so contradicted the activity feed's guarantee that tool results never reach
# the page. The terminal lives at `tmux attach` or ttyd (:8793), not here.


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


def include_extension_routers():
    """Extension routers go in last so the core always wins a path collision:
    Starlette serves the first matching route, so a colliding extension route is
    inert by construction. It is still a bug in the extension, so it is logged."""
    core_routes = list(app.router.routes)
    routers = registry.routers()
    for router in routers:
        app.include_router(router)
    registry.seal()
    claimed = {}
    for router in routers:
        for route in router.routes:
            for method in route.methods:
                winner = _first_matching_route(method, route.path)
                if winner in core_routes:
                    log.error("extension route %s %s is shadowed by core %s and will never be served",
                              method, route.path, winner.path)
                elif (method, route.path) in claimed:
                    log.error("extension route %s %s is shadowed by %s and will never be served",
                              method, route.path, claimed[(method, route.path)])
                claimed.setdefault((method, route.path), route.endpoint.__module__)


def _first_matching_route(method: str, path: str):
    scope = {"type": "http", "method": method, "path": path, "root_path": "", "headers": []}
    for route in app.router.routes:
        if route.matches(scope)[0] == Match.FULL:
            return route
    raise AssertionError(f"{method} {path} matches no route, not even its own")


include_extension_routers()
