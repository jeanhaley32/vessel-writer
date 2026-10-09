"""Virtual filesystem over the blob store.

The folders / paths / filenames the user sees are metadata, not real nested
files. This SQLite index maps a virtual path to the CURRENT blob hash, plus a
full version history. Renaming or moving a document is a cheap metadata edit —
no blob is touched. The substance is always the blobs; this is just the view.

The DB lives on disk at <root>/index.sqlite (backed up with everything else).
On every mutation we also re-emit <root>/manifest.json (path -> current hash)
so the whole structure is serialized on disk for the ingestion path (Slice 2)
to read without touching this app.
"""
from __future__ import annotations

import functools
import json
import sqlite3
import threading
import time
from pathlib import Path

from blobstore import BlobStore

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL DEFAULT '',
    current_hash TEXT NOT NULL,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL,
    deleted_at  REAL             -- tombstone: set on delete, NULL while live
);
CREATE TABLE IF NOT EXISTS versions (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    hash    TEXT NOT NULL,
    at      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_doc ON versions(doc_id);
CREATE TABLE IF NOT EXISTS folders (
    path       TEXT PRIMARY KEY,
    created_at REAL NOT NULL
);
"""

# Version retention (per Jean 2026-09-08): the frontend autosaves every ~1.2s
# for crash-safety, but saves landing within VERSION_CADENCE_S of the current
# version REPLACE it in place (intermediate blob GC'd) rather than appending —
# so version history is ~30s-granular instead of exploding. We keep at most
# 12 hours of work-time of those 30s slots, then thin the oldest.
VERSION_CADENCE_S = 30
RETENTION_VERSIONS = 12 * 3600 // VERSION_CADENCE_S   # 12h work / 30s = 1440


def norm(path: str) -> str:
    """Normalize a virtual path: strip surrounding slashes, drop empty, '.' and
    '..' segments. A path can never name anything outside the virtual tree."""
    parts = [p for p in path.strip().strip("/").split("/") if p not in ("", ".", "..")]
    return "/".join(parts)


def _under(folder: str) -> tuple[str, str]:
    """SQL bounds (low, high) for 'every path below this folder'. A range test,
    not LIKE: '_' and '%' are legal in a folder name and LIKE would read them as
    wildcards, so removing 'a_b' would also take everything under 'axb'."""
    return folder + "/", folder + "0"      # '0' is the character after '/'


def _locked(method):
    """One sqlite connection is shared by every request thread, and a method
    is several statements ending in one commit. Without the lock two requests
    can interleave inside each other's transaction."""
    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)
    return wrapper


class VFS:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.blobs = BlobStore(self.root)
        self.db = sqlite3.connect(self.root / "index.sqlite", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.executescript(SCHEMA)
        # migrate older DBs that predate the deleted_at tombstone column
        cols = [r[1] for r in self.db.execute("PRAGMA table_info(documents)").fetchall()]
        if "deleted_at" not in cols:
            self.db.execute("ALTER TABLE documents ADD COLUMN deleted_at REAL")
        self.db.commit()

    def close(self) -> None:
        with self._lock:
            self.db.close()

    # --- reads ---
    @_locked
    def tree(self) -> list[dict]:
        rows = self.db.execute(
            "SELECT path, title, current_hash, created_at, updated_at FROM documents "
            "WHERE deleted_at IS NULL ORDER BY path"
        ).fetchall()
        return [dict(r) for r in rows]

    @_locked
    def folders(self) -> list[str]:
        return [r["path"] for r in
                self.db.execute("SELECT path FROM folders ORDER BY path").fetchall()]

    @_locked
    def structure(self) -> dict:
        """Everything the UI needs to render a directory tree: explicit folders
        (including empty ones) + live documents."""
        return {"folders": self.folders(), "documents": self.tree()}

    @_locked
    def read(self, path: str) -> dict | None:
        path = norm(path)
        r = self.db.execute("SELECT * FROM documents WHERE path=?", (path,)).fetchone()
        if not r:
            return None
        content = self.blobs.get(r["current_hash"]).decode("utf-8", "replace")
        return {"path": r["path"], "title": r["title"], "hash": r["current_hash"],
                "content": content, "created_at": r["created_at"], "updated_at": r["updated_at"]}

    @_locked
    def history(self, path: str) -> list[dict]:
        path = norm(path)
        r = self.db.execute("SELECT id FROM documents WHERE path=?", (path,)).fetchone()
        if not r:
            return []
        rows = self.db.execute(
            "SELECT hash, at FROM versions WHERE doc_id=? ORDER BY at DESC", (r["id"],)
        ).fetchall()
        return [dict(x) for x in rows]

    @_locked
    def version_content(self, path: str, digest: str) -> str | None:
        """Read the exact text of one historical version. The hash must belong
        to this document's own version chain (or be its current hash) — we never
        serve an arbitrary blob by hash through this door."""
        path = norm(path)
        r = self.db.execute("SELECT id, current_hash FROM documents WHERE path=?", (path,)).fetchone()
        if not r:
            return None
        allowed = digest == r["current_hash"] or self.db.execute(
            "SELECT 1 FROM versions WHERE doc_id=? AND hash=? LIMIT 1", (r["id"], digest)).fetchone()
        if not allowed:
            return None
        return self.blobs.get(digest).decode("utf-8", "replace")

    @_locked
    def restore(self, path: str, digest: str) -> dict | None:
        """Restore an earlier version as the document's current text. Implemented
        as a forward write of that old content into a fresh version slot, so the
        current text is never lost — restoring is itself an undoable edit."""
        path = norm(path)
        content = self.version_content(path, digest)
        if content is None:
            return None
        row = self.db.execute("SELECT id, current_hash FROM documents WHERE path=?", (path,)).fetchone()
        if row["current_hash"] == digest:
            # already at this version — nothing to write, just report it
            return {"path": path, "hash": digest, "content": content, "new_version": False}
        now = time.time()
        self.db.execute("INSERT INTO versions(doc_id,hash,at) VALUES(?,?,?)", (row["id"], digest, now))
        self.db.execute("UPDATE documents SET current_hash=?, updated_at=? WHERE id=?", (digest, now, row["id"]))
        self.db.commit()
        self._emit_manifest()
        return {"path": path, "hash": digest, "content": content, "new_version": True}

    # --- writes ---
    @_locked
    def save(self, path: str, content: str, title: str | None = None) -> dict:
        path = norm(path)
        if not path:
            raise ValueError("empty path")
        digest = self.blobs.put(content.encode("utf-8"))
        now = time.time()
        row = self.db.execute("SELECT * FROM documents WHERE path=?", (path,)).fetchone()

        # New document -> first version.
        if row is None:
            cur = self.db.execute(
                "INSERT INTO documents(path,title,current_hash,created_at,updated_at) VALUES(?,?,?,?,?)",
                (path, title or path.rsplit("/", 1)[-1], digest, now, now))
            self.db.execute("INSERT INTO versions(doc_id,hash,at) VALUES(?,?,?)", (cur.lastrowid, digest, now))
            self.db.commit()
            self._emit_manifest()
            # first version of a new doc = a new version slot -> worth ingesting
            return {"path": path, "hash": digest, "changed": True, "new_version": True}

        doc_id = row["id"]
        # Writing to a deleted path brings the document back. Left tombstoned it
        # would stay hidden from the tree and the reaper would purge the new text.
        revived = row["deleted_at"] is not None
        if revived:
            self.db.execute("UPDATE documents SET deleted_at=NULL WHERE id=?", (doc_id,))
        # Identical content -> idempotent no-op (content-addressing pays off here).
        if row["current_hash"] == digest:
            if revived:
                self.db.commit()
                self._emit_manifest()
            return {"path": path, "hash": digest, "changed": False, "new_version": False, "revived": revived}

        # Content changed. Coalesce into the current ~30s version slot: a save
        # arriving within VERSION_CADENCE_S of the latest version REPLACES it
        # (the intermediate blob is GC'd); otherwise it opens a new slot.
        latest = self.db.execute(
            "SELECT id, hash, at FROM versions WHERE doc_id=? ORDER BY at DESC LIMIT 1", (doc_id,)).fetchone()
        replaced = None
        if latest and (now - latest["at"]) < VERSION_CADENCE_S:
            replaced = latest["hash"]
            self.db.execute("UPDATE versions SET hash=? WHERE id=?", (digest, latest["id"]))
            new_version = False   # coalesced into the open slot — not a new version
        else:
            self.db.execute("INSERT INTO versions(doc_id,hash,at) VALUES(?,?,?)", (doc_id, digest, now))
            new_version = True    # opened a new 30s slot — worth (re)ingesting
        new_title = title if title is not None else row["title"]
        self.db.execute("UPDATE documents SET current_hash=?, updated_at=?, title=? WHERE id=?",
                        (digest, now, new_title, doc_id))

        # Retention: keep at most RETENTION_VERSIONS newest versions for this doc.
        dropped = [r["hash"] for r in self.db.execute(
            "SELECT hash FROM versions WHERE doc_id=? ORDER BY at DESC LIMIT -1 OFFSET ?",
            (doc_id, RETENTION_VERSIONS)).fetchall()]
        if dropped:
            self.db.execute(
                "DELETE FROM versions WHERE id IN (SELECT id FROM versions WHERE doc_id=? ORDER BY at DESC LIMIT -1 OFFSET ?)",
                (doc_id, RETENTION_VERSIONS))
        self.db.commit()

        # GC any blob no longer referenced by a version or a document's current_hash.
        for h in [replaced, *dropped]:
            self._gc_blob(h)
        self._emit_manifest()
        return {"path": path, "hash": digest, "changed": True, "new_version": new_version, "revived": revived}

    def _gc_blob(self, digest: str | None) -> None:
        if not digest:
            return
        if self.db.execute("SELECT 1 FROM versions WHERE hash=? LIMIT 1", (digest,)).fetchone():
            return
        if self.db.execute("SELECT 1 FROM documents WHERE current_hash=? LIMIT 1", (digest,)).fetchone():
            return
        try:
            self.blobs._path(digest).unlink()
        except FileNotFoundError:
            pass

    @_locked
    def mkdir(self, path: str) -> dict:
        """Create a folder (and any missing ancestors). Empty folders persist."""
        path = norm(path)
        if not path:
            raise ValueError("empty folder path")
        now = time.time()
        parts = path.split("/")
        for i in range(1, len(parts) + 1):
            anc = "/".join(parts[:i])
            self.db.execute("INSERT OR IGNORE INTO folders(path, created_at) VALUES(?,?)", (anc, now))
        self.db.commit()
        return {"folder": path}

    @_locked
    def rmdir(self, path: str, recursive: bool = False) -> dict:
        """Remove a folder. Without recursive, refuse if it still holds folders
        or live documents. With recursive, soft-delete every doc underneath and
        drop the subfolders. The caller fires on_delete for each deleted doc."""
        path = norm(path)
        low, high = _under(path)
        docs = [r["path"] for r in self.db.execute(
            "SELECT path FROM documents WHERE deleted_at IS NULL AND path >= ? AND path < ?",
            (low, high)).fetchall()]
        subs = [r["path"] for r in self.db.execute(
            "SELECT path FROM folders WHERE path=? OR (path >= ? AND path < ?)",
            (path, low, high)).fetchall()]
        if not recursive and (docs or [s for s in subs if s != path]):
            raise ValueError("folder not empty")
        for d in docs:
            self.delete(d)
        for s in subs:
            self.db.execute("DELETE FROM folders WHERE path=?", (s,))
        self.db.commit()
        return {"removed_folder": path, "deleted_docs": docs}

    @_locked
    def move(self, old: str, new: str) -> dict:
        """Move/rename a file OR a folder. A folder move cascades to every
        descendant folder and document (prefix rewrite), the way mv works on a
        directory. Pure metadata — no blob touched. Refuses, with a reason,
        anything that would overwrite or orphan something."""
        old, new = norm(old), norm(new)
        if not old or not new:
            raise ValueError("empty path")
        is_folder = self.db.execute("SELECT 1 FROM folders WHERE path=?", (old,)).fetchone() is not None
        if old == new:
            return {"path": new, "folder": is_folder, "moved_docs": []}
        now = time.time()
        try:
            if is_folder:
                result = self._move_folder(old, new, now)
            else:
                result = self._move_file(old, new, now)
        except sqlite3.IntegrityError:
            self.db.rollback()
            raise ValueError(f"something already exists at {new!r}")
        except ValueError:
            self.db.rollback()
            raise
        self.db.commit()
        self._emit_manifest()
        return result

    def _exists(self, table: str, path: str) -> bool:
        return self.db.execute(f"SELECT 1 FROM {table} WHERE path=?", (path,)).fetchone() is not None

    def _move_file(self, old: str, new: str, now: float) -> dict:
        if not self._exists("documents", old):
            raise ValueError(f"no document at {old!r}")
        if self._exists("documents", new) or self._exists("folders", new):
            raise ValueError(f"something already exists at {new!r}")
        self.db.execute("UPDATE documents SET path=?, updated_at=? WHERE path=?", (new, now, old))
        return {"path": new, "folder": False, "moved_docs": [(old, new)]}

    def _move_folder(self, old: str, new: str, now: float) -> dict:
        if new.startswith(old + "/"):
            raise ValueError("a folder cannot move into itself")
        if self._exists("folders", new) or self._exists("documents", new):
            raise ValueError(f"something already exists at {new!r}")
        low, high = _under(old)
        for r in self.db.execute("SELECT path FROM folders WHERE path=? OR (path >= ? AND path < ?)",
                                 (old, low, high)).fetchall():
            self.db.execute("UPDATE folders SET path=? WHERE path=?", (new + r["path"][len(old):], r["path"]))
        moved_docs = []
        for r in self.db.execute("SELECT path FROM documents WHERE path >= ? AND path < ?", (low, high)).fetchall():
            target = new + r["path"][len(old):]
            self.db.execute("UPDATE documents SET path=?, updated_at=? WHERE path=?", (target, now, r["path"]))
            moved_docs.append((r["path"], target))
        return {"path": new, "folder": True, "moved_docs": moved_docs}

    @_locked
    def delete(self, path: str) -> dict:
        """Soft delete: tombstone the doc (hidden from the tree/manifest, kept
        in the DB + blobs) so recall can exclude it immediately and the reaper
        can physically purge it later — the gap is a free undo window."""
        path = norm(path)
        self.db.execute("UPDATE documents SET deleted_at=? WHERE path=? AND deleted_at IS NULL",
                        (time.time(), path))
        self.db.commit()
        self._emit_manifest()
        return {"deleted": path}

    @_locked
    def undelete(self, path: str) -> dict:
        path = norm(path)
        self.db.execute("UPDATE documents SET deleted_at=NULL WHERE path=?", (path,))
        self.db.commit()
        self._emit_manifest()
        return {"restored": path}

    @_locked
    def tombstones(self, older_than_s: float | None = None) -> list[dict]:
        """Deleted docs, optionally only those tombstoned longer than a grace
        period (for the reaper)."""
        if older_than_s is None:
            rows = self.db.execute(
                "SELECT path, deleted_at FROM documents WHERE deleted_at IS NOT NULL").fetchall()
        else:
            cutoff = time.time() - older_than_s
            rows = self.db.execute(
                "SELECT path, deleted_at FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < ?",
                (cutoff,)).fetchall()
        return [dict(r) for r in rows]

    @_locked
    def purge(self, path: str) -> dict:
        """Hard delete: remove the doc row + all its versions, and GC every blob
        no longer referenced. Called by the reaper after PG/Qdrant are cleared."""
        path = norm(path)
        r = self.db.execute("SELECT id, current_hash FROM documents WHERE path=?", (path,)).fetchone()
        if not r:
            return {"purged": path, "found": False}
        hashes = [x["hash"] for x in
                  self.db.execute("SELECT hash FROM versions WHERE doc_id=?", (r["id"],)).fetchall()]
        hashes.append(r["current_hash"])
        self.db.execute("DELETE FROM versions WHERE doc_id=?", (r["id"],))
        self.db.execute("DELETE FROM documents WHERE id=?", (r["id"],))
        self.db.commit()
        for h in set(hashes):
            self._gc_blob(h)
        self._emit_manifest()
        return {"purged": path, "found": True}

    def _emit_manifest(self):
        m = {r["path"]: r["current_hash"] for r in
             self.db.execute("SELECT path, current_hash FROM documents WHERE deleted_at IS NULL").fetchall()}
        tmp = self.root / "manifest.json.tmp"
        tmp.write_text(json.dumps(m, indent=2, sort_keys=True))
        tmp.replace(self.root / "manifest.json")
