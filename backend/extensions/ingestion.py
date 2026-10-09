"""Slice 2 — recall ingestion.

Attaches to the core's on_save hook (zero core changes). On each real save it:
  1. upserts the document (path, title, hash, full text) into Postgres, and
  2. chunks the markdown, embeds each chunk with the local model, and upserts
     the chunk vectors into a Qdrant collection for semantic recall.

Idempotent by content hash: if the stored hash already matches, it does nothing.
Runs the (slow) embedding on a background thread so it never blocks a save.
Fail-soft: any backend hiccup is logged and swallowed — writing must never break
because recall infrastructure is momentarily down.

Config comes from ingestion.env (see the systemd unit's EnvironmentFile):
  INGEST_PG_DSN, INGEST_QDRANT_URL, INGEST_OLLAMA_URL, INGEST_COLLECTION,
  INGEST_EMBED_MODEL. If INGEST_PG_DSN is unset the extension disables itself.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import urllib.error
import urllib.request
import uuid

from . import registry

log = logging.getLogger("vessel-writer.ingest")

PG_DSN = os.environ.get("INGEST_PG_DSN", "")
QDRANT = os.environ.get("INGEST_QDRANT_URL", "http://127.0.0.1:6333").rstrip("/")
OLLAMA = os.environ.get("INGEST_OLLAMA_URL", "http://localhost:11434").rstrip("/")
COLLECTION = os.environ.get("INGEST_COLLECTION", "vessel_writing")
EMBED_MODEL = os.environ.get("INGEST_EMBED_MODEL", "nomic-embed-text")
_NS = uuid.UUID("6f9619ff-8b86-d011-b42d-00cf4fc964ff")  # stable namespace for chunk ids

_lock = threading.Lock()
_schema_ready = False


def _http(method: str, url: str, body: dict | None = None, timeout: int = 120):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def _embed(text: str) -> list[float]:
    out = _http("POST", f"{OLLAMA}/api/embeddings",
                {"model": EMBED_MODEL, "prompt": text}, timeout=180)
    return out["embedding"]


def _chunk(text: str, target: int = 900, overlap: int = 150) -> list[str]:
    """Chunk markdown on blank-line paragraph boundaries, packing to ~target
    chars with a little overlap so a passage isn't split mid-thought."""
    paras = [p.strip() for p in text.replace("\r\n", "\n").split("\n\n") if p.strip()]
    chunks, cur = [], ""
    for p in paras:
        if cur and len(cur) + len(p) + 2 > target:
            chunks.append(cur)
            cur = (cur[-overlap:] + "\n\n" + p) if overlap else p
        else:
            cur = (cur + "\n\n" + p) if cur else p
    if cur:
        chunks.append(cur)
    return chunks or ([text.strip()] if text.strip() else [])


def _ensure_schema():
    global _schema_ready
    if _schema_ready:
        return
    import psycopg
    with psycopg.connect(PG_DSN, connect_timeout=10) as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS writing_documents (
                path       text PRIMARY KEY,
                title      text,
                hash       text NOT NULL,
                content    text NOT NULL,
                updated_at timestamptz NOT NULL DEFAULT now(),
                deleted_at timestamptz
            )""")
        c.execute("ALTER TABLE writing_documents ADD COLUMN IF NOT EXISTS deleted_at timestamptz")
        c.commit()
    # size the Qdrant collection from a real embedding so the dim is never wrong
    dim = len(_embed("dimension probe"))
    try:
        _http("PUT", f"{QDRANT}/collections/{COLLECTION}",
              {"vectors": {"size": dim, "distance": "Cosine"}})
    except urllib.error.HTTPError as e:
        if e.code not in (409,):  # already exists is fine
            raise
    # index the path payload so we can delete-by-path on re-ingest
    try:
        _http("PUT", f"{QDRANT}/collections/{COLLECTION}/index",
              {"field_name": "path", "field_schema": "keyword"})
    except Exception:
        log.warning("could not index the path payload; delete-by-path will scan", exc_info=True)
    _schema_ready = True


def _existing_chunks(path: str):
    """Scroll this doc's current Qdrant points, returning (by_chash, legacy_ids):
    a {chunk_hash: point_id} map for points that carry a chunk_hash, and a list
    of point ids from the old index-keyed scheme (no chunk_hash) to be rebuilt."""
    by_chash, legacy_ids = {}, []
    offset = None
    while True:
        body = {"filter": {"must": [{"key": "path", "match": {"value": path}}]},
                "with_payload": ["chunk_hash"], "with_vector": False, "limit": 256}
        if offset is not None:
            body["offset"] = offset
        res = _http("POST", f"{QDRANT}/collections/{COLLECTION}/points/scroll", body) or {}
        result = res.get("result", {})
        for p in result.get("points", []):
            chash = (p.get("payload") or {}).get("chunk_hash")
            if chash:
                by_chash[chash] = p["id"]
            else:
                legacy_ids.append(p["id"])
        offset = result.get("next_page_offset")
        if not offset:
            break
    return by_chash, legacy_ids


def _ingest(path: str, title: str, content: str, digest: str):
    import psycopg
    # skip if this exact content is already ingested (idempotent on hash)
    with psycopg.connect(PG_DSN, connect_timeout=10) as c:
        row = c.execute("SELECT hash FROM writing_documents WHERE path=%s", (path,)).fetchone()
        if row and row[0] == digest:
            return
        c.execute("""
            INSERT INTO writing_documents(path,title,hash,content,updated_at)
            VALUES(%s,%s,%s,%s, now())
            ON CONFLICT (path) DO UPDATE SET
                title=EXCLUDED.title, hash=EXCLUDED.hash,
                content=EXCLUDED.content, updated_at=now()
            """, (path, title, digest, content))
        c.commit()

    # Incremental re-embed: only chunks whose CONTENT changed are (re)embedded.
    # Chunks are keyed by their own content hash, so an edit to one paragraph
    # leaves every other chunk's vector untouched — cost scales with the edit,
    # not the document size. (Also survives a rename: unchanged chunks are matched
    # by content hash from the scroll, not by a path-derived id.)
    want = {}  # chunk_hash -> (idx, text)
    for i, ch in enumerate(_chunk(content)):
        want[hashlib.sha256(ch.encode("utf-8")).hexdigest()] = (i, ch)

    by_chash, legacy_ids = _existing_chunks(path)
    to_add = [ch for ch in want if ch not in by_chash]
    del_ids = list(legacy_ids) + [pid for ch, pid in by_chash.items() if ch not in want]

    if del_ids:
        _http("POST", f"{QDRANT}/collections/{COLLECTION}/points/delete", {"points": del_ids})
    points = []
    for chash in to_add:
        idx, ch = want[chash]
        vec = _embed(ch)
        pid = str(uuid.uuid5(_NS, f"{path}:{chash}"))
        points.append({"id": pid, "vector": vec,
                       "payload": {"path": path, "title": title, "hash": digest,
                                   "chunk_hash": chash, "chunk_idx": idx, "text": ch}})
    if points:
        _http("PUT", f"{QDRANT}/collections/{COLLECTION}/points", {"points": points})
    log.info("ingested %s (%d chunks: +%d embedded, -%d removed, %d reused)",
             path, len(want), len(to_add), len(del_ids), len(want) - len(to_add))


def _mark_deleted(path: str, deleted: bool):
    """Tombstone marker: flag PG row + Qdrant points so recall excludes the doc
    immediately, without physically removing anything (the reaper does that)."""
    import psycopg
    from datetime import datetime, timezone
    ts = datetime.now(timezone.utc) if deleted else None
    with _lock:
        _ensure_schema()
        with psycopg.connect(PG_DSN, connect_timeout=10) as c:
            c.execute("UPDATE writing_documents SET deleted_at=%s WHERE path=%s", (ts, path))
            c.commit()
        # flag the doc's Qdrant points (set-payload by path filter)
        try:
            _http("POST", f"{QDRANT}/collections/{COLLECTION}/points/payload",
                  {"payload": {"deleted": deleted},
                   "filter": {"must": [{"key": "path", "match": {"value": path}}]}})
        except Exception:
            log.exception("qdrant mark-deleted failed for %s", path)


def _purge(path: str):
    """Hard-remove a doc from PG + Qdrant (reaper path)."""
    import psycopg
    with _lock:
        _ensure_schema()
        with psycopg.connect(PG_DSN, connect_timeout=10) as c:
            c.execute("DELETE FROM writing_documents WHERE path=%s", (path,))
            c.commit()
        _http("POST", f"{QDRANT}/collections/{COLLECTION}/points/delete",
              {"filter": {"must": [{"key": "path", "match": {"value": path}}]}})
    log.info("purged %s from PG + Qdrant", path)


def search(query: str, limit: int = 6) -> list[dict]:
    """Semantic recall over live (non-deleted) writing. Returns matching chunks."""
    if not PG_DSN:
        return []
    vec = _embed(query)
    res = _http("POST", f"{QDRANT}/collections/{COLLECTION}/points/search",
                {"vector": vec, "limit": limit, "with_payload": True,
                 "filter": {"must_not": [{"key": "deleted", "match": {"value": True}}]}})
    out = []
    for r in (res or {}).get("result", []):
        p = r.get("payload", {})
        out.append({"score": r.get("score"), "path": p.get("path"),
                    "title": p.get("title"), "text": p.get("text")})
    return out


def _on_save(vfs=None, path=None, hash=None, **_):
    if not PG_DSN:
        return
    doc = vfs.read(path)
    if not doc:
        return

    def work():
        try:
            with _lock:
                _ensure_schema()
                _ingest(path, doc["title"], doc["content"], hash)
        except Exception:
            log.exception("ingest failed for %s", path)

    threading.Thread(target=work, daemon=True).start()


def reconcile(vfs) -> dict:
    """Backfill/catch-up: ingest any document whose current hash isn't the one
    already stored. Safe to run repeatedly."""
    if not PG_DSN:
        return {"disabled": True}
    import psycopg
    done = 0
    with _lock:      # the same lock the save hook takes, so the two never ingest at once
        _ensure_schema()
        with psycopg.connect(PG_DSN, connect_timeout=10) as c:
            for d in vfs.tree():
                row = c.execute("SELECT hash FROM writing_documents WHERE path=%s", (d["path"],)).fetchone()
                if not row or row[0] != d["current_hash"]:
                    doc = vfs.read(d["path"])
                    _ingest(d["path"], doc["title"], doc["content"], d["current_hash"])
                    done += 1
    return {"reconciled": done}


def _on_delete(vfs=None, path=None, **_):
    if not PG_DSN or not path:
        return
    threading.Thread(target=lambda: _guard(_mark_deleted, path, True), daemon=True).start()


def _on_undelete(vfs=None, path=None, **_):
    if not PG_DSN or not path:
        return
    threading.Thread(target=lambda: _guard(_mark_deleted, path, False), daemon=True).start()


def _on_purge(vfs=None, path=None, **_):
    if not PG_DSN or not path:
        return
    _guard(_purge, path)   # reaper is synchronous/low-frequency; run inline


def _repath(old: str, new: str):
    """A move/rename changed a doc's path — update its path in PG and in the
    Qdrant point payloads so recall follows the file. Pure metadata, no re-embed."""
    import psycopg
    with _lock:
        _ensure_schema()
        with psycopg.connect(PG_DSN, connect_timeout=10) as c:
            c.execute("UPDATE writing_documents SET path=%s WHERE path=%s", (new, old))
            c.commit()
        _http("POST", f"{QDRANT}/collections/{COLLECTION}/points/payload",
              {"payload": {"path": new},
               "filter": {"must": [{"key": "path", "match": {"value": old}}]}})


def _on_move(vfs=None, old=None, new=None, **_):
    if not PG_DSN or not old or not new:
        return
    threading.Thread(target=lambda: _guard(_repath, old, new), daemon=True).start()


def _guard(fn, *a):
    try:
        fn(*a)
    except Exception:
        log.exception("%s failed", getattr(fn, "__name__", fn))


if PG_DSN:
    registry.on("on_save", _on_save)
    registry.on("on_delete", _on_delete)
    registry.on("on_undelete", _on_undelete)
    registry.on("on_purge", _on_purge)
    registry.on("on_move", _on_move)
    log.info("ingestion extension armed (collection=%s)", COLLECTION)
else:
    log.warning("ingestion disabled: INGEST_PG_DSN unset")
