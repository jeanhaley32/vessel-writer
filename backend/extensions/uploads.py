"""Pasted and dropped images.

An image is stored once, named by the hash of its bytes, so pasting the same
screenshot twice costs nothing and a document that links it never goes stale.
Only raster formats whose magic bytes check out are accepted. SVG is refused on
purpose: served from the writer's own origin it could run script.

The response carries both the URL the editor links to and the absolute path on
this box, because the chat sends the path so Rodin can open the file.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from . import registry, statefile

log = logging.getLogger("vessel-writer.uploads")

UPLOAD_DIR = Path(os.path.expanduser(
    os.environ.get("WRITER_UPLOAD_DIR", str(statefile.STATE_DIR / "uploads"))))
MAX_BYTES = 12 * 1024 * 1024
NAME = re.compile(r"^[0-9a-f]{20}\.(png|jpg|gif|webp)$")

router = APIRouter()


def _kind(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


@router.post("/api/upload")
async def upload(request: Request):
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BYTES:
        raise HTTPException(413, "image too large")
    data = await request.body()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "image too large")
    kind = _kind(data)
    if kind is None:
        raise HTTPException(415, "only png, jpeg, gif and webp images are accepted")
    name = f"{hashlib.sha256(data).hexdigest()[:20]}.{kind}"
    path = UPLOAD_DIR / name
    if not path.exists():
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        tmp.write_bytes(data)
        tmp.rename(path)
    return {"name": name, "url": f"api/upload/{name}", "path": str(path)}


@router.get("/api/upload/{name}")
def fetch(name: str):
    if not NAME.match(name):
        raise HTTPException(404, "not found")
    path = UPLOAD_DIR / name
    if not path.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable",
                                       "X-Content-Type-Options": "nosniff"})


registry.route(router)
