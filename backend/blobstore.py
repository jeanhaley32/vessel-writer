"""Content-addressed blob store.

Every version of a document is stored as an immutable blob named by the
SHA-256 of its content. This is the heart of the design (see README):
  - change detection is free: same content -> same hash -> nothing to do;
  - version history is free: a new save is just a new blob, nothing overwritten;
  - dedup is free: identical content stored once.

Blobs live as flat hash-named files under <root>/blobs/, so the whole corpus
is trivially serialized on disk and ingestible without the app running.
"""
from __future__ import annotations

import gzip
import hashlib
import os
import re
from pathlib import Path

_GZIP_MAGIC = b"\x1f\x8b"
_DIGEST = re.compile(r"^[0-9a-f]{64}$")


class BlobStore:
    def __init__(self, root: Path):
        self.dir = Path(root) / "blobs"
        self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, digest: str) -> Path:
        # A digest becomes a filesystem path, so only a real one may.
        if not _DIGEST.match(digest):
            raise ValueError("not a sha256 digest")
        # shard by first 2 hex chars to keep directories small at scale
        return self.dir / digest[:2] / digest

    def put(self, content: bytes) -> str:
        """Store content, return its sha256 hex digest. Idempotent.

        The digest is always the hash of the ORIGINAL (uncompressed) content, so
        content-addressing is unchanged; blobs are just gzip-compressed at rest
        (markdown compresses ~3-5x). A blob already on disk is never rewritten,
        so legacy uncompressed blobs stay as they are and remain readable."""
        digest = hashlib.sha256(content).hexdigest()
        p = self._path(digest)
        if not p.exists():
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".tmp")           # atomic write: temp then rename
            tmp.write_bytes(gzip.compress(content, compresslevel=6, mtime=0))
            os.replace(tmp, p)
        return digest

    def get(self, digest: str) -> bytes:
        raw = self._path(digest).read_bytes()
        # New blobs are gzip; legacy blobs are raw. Decompress only when the
        # gzip magic is present AND the result hashes back to the digest — so a
        # (near-impossible) raw file that happens to start with the magic can
        # never be mis-decoded.
        if raw[:2] == _GZIP_MAGIC:
            try:
                dec = gzip.decompress(raw)
                if hashlib.sha256(dec).hexdigest() == digest:
                    return dec
            except OSError:
                pass
        return raw

    def has(self, digest: str) -> bool:
        return self._path(digest).exists()
