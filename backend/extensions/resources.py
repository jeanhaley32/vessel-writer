"""Resource launcher — one page of links to everything hosted on this box.

The list is data, not markup: adding a tool means one line of JSON and no code
change, which was the stated requirement. Read per request rather than cached
at import, so an edit shows up on the next reload instead of the next restart.

Which file: $RESOURCES_FILE, else <state dir>/resources.json (the owner's own
list, which stays out of the repository), else the starter list shipped beside
this module.

Relative URLs ("/writer/") resolve against whatever host served the page, and
a bare port (":3000") is expanded client-side against the same hostname — so
nothing here hardcodes the tailnet address.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

from . import registry, statefile

log = logging.getLogger("vessel-writer.resources")

HERE = Path(__file__).resolve().parent
STARTER_LIST = HERE / "resources.json"
STATIC = HERE.parent.parent / "static"

router = APIRouter()


def list_file() -> Path:
    override = os.environ.get("RESOURCES_FILE")
    if override:
        return Path(override)
    owners = statefile.STATE_DIR / "resources.json"
    return owners if owners.is_file() else STARTER_LIST


@router.get("/api/resources")
def resources():
    """The launcher's entries. A missing or broken list yields an empty page
    rather than a 500 — a launcher is a convenience and must not be able to
    take the writer down with it."""
    path = list_file()
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        log.exception("could not read %s", path)
        return {"resources": []}


@router.get("/launcher")
def launcher():
    return FileResponse(STATIC / "launcher.html")


registry.route(router)
