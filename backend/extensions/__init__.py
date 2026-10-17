"""Extension registry — the seam that keeps the core small.

Features (Slice 2 ingestion, PDF export, tags, backlinks, ...) register hook
callbacks here instead of editing the core. Slice 1 ships the registry with no
extensions loaded; the on_save hook is already fired by the app so the Slice 2
ingestion worker can attach to it with zero core changes.

A hook callback signature is free-form kwargs; failures are isolated so a
broken extension can never take down a save.

Extensions that need an endpoint register a router instead of editing the core.
The registry stays framework-agnostic — it only holds the objects — and app.py
includes whatever has been registered once extensions have imported, then seals
the registry so a late registration fails loudly instead of never being served.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from typing import Callable

log = logging.getLogger("vessel-writer.ext")


class Registry:
    def __init__(self):
        self._hooks: dict[str, list[Callable]] = defaultdict(list)
        self._routers: list = []
        self._sealed = False

    def on(self, event: str, fn: Callable):
        self._hooks[event].append(fn)

    def route(self, router):
        """Register a router (a FastAPI APIRouter) for the core to include."""
        if self._sealed:
            raise RuntimeError(
                "extension router registered after the app included its routes; "
                "it would never be served. Register at import of the extensions package.")
        self._routers.append(router)

    def routers(self):
        return list(self._routers)

    def seal(self):
        self._sealed = True

    def fire(self, event: str, **kwargs):
        for fn in self._hooks.get(event, []):
            try:
                fn(**kwargs)
            except Exception:  # an extension must never break a save
                log.exception("extension hook %s failed", event)


registry = Registry()

# Extensions self-register on import. Slice 2 ingestion attaches to on_save.
from . import ingestion  # noqa: E402,F401
from . import activity  # noqa: E402,F401
from . import resources  # noqa: E402,F401
from . import comments  # noqa: E402,F401
from . import listening  # noqa: E402,F401
from . import uploads  # noqa: E402,F401
from . import board  # noqa: E402,F401
