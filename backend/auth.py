"""Owner authentication: one token, one owner.

Off until a token exists, so an install on loopback behaves as it always has.
Once WRITER_TOKEN is set (or the token file exists), every request needs either
the session cookie a browser gets by logging in, or the token as a bearer
header (scripts, the MCP adapter, Rodin's curl).

Two rules that are easy to get wrong:
  - Loopback is not trusted. Behind the reverse proxy every request arrives
    from 127.0.0.1, so trusting loopback would trust everyone the proxy admits.
  - An install that binds beyond loopback with no token refuses to start
    (check_bind), so a careless deploy fails loudly instead of running open.

The cookie carries an HMAC of the token, never the token itself, so changing
the token signs every browser out.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import os
import secrets
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from pydantic import BaseModel

import siteconfig

COOKIE = "vw_session"
COOKIE_MAX_AGE_S = 90 * 86400
LINK_TTL_S = 300
FAILED_LOGIN_DELAY_S = 0.5
TOKEN_FILE = Path(os.path.expanduser(os.environ.get("WRITER_TOKEN_FILE") or str(siteconfig.STATE_DIR / "token")))

# Reachable without a session: the login itself, and the pages that show the
# login form in place of the app.
OPEN_PATHS = {("POST", "/api/login"), ("GET", "/login")}
LOGIN_PAGES = {"/", "/launcher"}

router = APIRouter()
_links: dict[str, float] = {}      # one-time login code -> expiry (monotonic)


def token() -> str:
    """The configured token, or "" when auth is off. Read per call so a token
    file written while the app runs takes effect without a restart."""
    value = os.environ.get("WRITER_TOKEN", "").strip()
    if value:
        return value
    try:
        return TOKEN_FILE.read_text().strip()
    except OSError:
        return ""


def enabled() -> bool:
    return bool(token())


def _session_value(tok: str) -> str:
    return hmac.new(tok.encode(), b"vessel-writer session", hashlib.sha256).hexdigest()


def _authorised(request: Request, tok: str) -> bool:
    bearer = request.headers.get("authorization", "")
    if bearer.lower().startswith("bearer ") and hmac.compare_digest(bearer[7:].strip(), tok):
        return True
    cookie = request.cookies.get(COOKIE, "")
    return bool(cookie) and hmac.compare_digest(cookie, _session_value(tok))


def check_bind(host: str) -> None:
    """Refuse to serve beyond loopback with no token."""
    if enabled():
        return
    try:
        loopback = host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = False
    if not loopback:
        raise SystemExit(f"vessel-writer: refusing to bind {host} without WRITER_TOKEN; "
                         "set a token or bind to 127.0.0.1")


class AuthMiddleware:
    """Plain ASGI rather than BaseHTTPMiddleware, which wraps every response in
    a stream of its own and has a history of breaking disconnect detection on
    long-lived SSE responses like the sync and comment streams."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        tok = token()
        request = Request(scope)
        if not tok or (request.method, request.url.path) in OPEN_PATHS or _authorised(request, tok):
            return await self.app(scope, receive, send)
        if request.method == "GET" and request.url.path in LOGIN_PAGES:
            response = HTMLResponse(LOGIN_PAGE, status_code=401)
        else:
            response = JSONResponse({"detail": "log in first"}, status_code=401)
        await response(scope, receive, send)


def _set_session(response: Response, request: Request, tok: str) -> Response:
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(COOKIE, _session_value(tok), max_age=COOKIE_MAX_AGE_S,
                        httponly=True, samesite="strict", secure=secure)
    return response


class LoginBody(BaseModel):
    token: str


@router.get("/api/auth/check")
def auth_check():
    """For the reverse proxy's auth_request: 204 when the caller is signed in.
    The middleware has already refused anyone who is not, with a 401."""
    return Response(status_code=204)


@router.post("/api/login")
async def login(body: LoginBody, request: Request):
    tok = token()
    if not tok:
        return {"ok": True}
    if not hmac.compare_digest(body.token.strip(), tok):
        await asyncio.sleep(FAILED_LOGIN_DELAY_S)
        raise HTTPException(401, "that is not the token")
    return _set_session(JSONResponse({"ok": True}), request, tok)


@router.post("/api/login-link")
def login_link():
    """A one-time code for signing a device in without typing the token. Only
    an already-authorised caller reaches this (the middleware sees to it)."""
    now = time.monotonic()
    for code, expiry in list(_links.items()):
        if expiry < now:
            del _links[code]
    code = secrets.token_urlsafe(24)
    _links[code] = now + LINK_TTL_S
    return {"path": f"login?code={code}", "expires_in_s": LINK_TTL_S}


@router.get("/login")
def redeem(code: str, request: Request):
    tok = token()
    expiry = _links.pop(code, None)
    if not tok or expiry is None or expiry < time.monotonic():
        return HTMLResponse(LOGIN_PAGE.replace("<!--note-->",
                            '<p class="note">That link has expired or was already used.</p>'),
                            status_code=401)
    # Relative, so it lands on the app whatever prefix the proxy mounts it at.
    return _set_session(RedirectResponse("./", status_code=303), request, tok)


LOGIN_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vessel-writer</title>
<style>
  :root { color-scheme: light dark; --ink:#2b2a27; --paper:#f7f5f0; --line:#d9d4c7; --accent:#b8561f; }
  @media (prefers-color-scheme: dark) { :root { --ink:#e8e4da; --paper:#1d1c1a; --line:#3a3833; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--paper);
         color:var(--ink); font:16px/1.5 Georgia, "Iowan Old Style", serif; padding:16px; box-sizing:border-box; }
  form { width:min(22rem, 100%); display:grid; gap:.75rem; }
  h1 { font-size:1.25rem; font-weight:normal; margin:0 0 .5rem; letter-spacing:.02em; }
  label { font-size:.85rem; }
  input { font:inherit; padding:.6rem .7rem; border:1px solid var(--line); border-radius:4px;
          background:transparent; color:inherit; }
  button { font:inherit; padding:.6rem; border:0; border-radius:4px; background:var(--accent); color:#fff; cursor:pointer; }
  .note { font-size:.9rem; margin:0; }
  #err { color:var(--accent); min-height:1.5em; }
</style></head>
<body>
<form id="f" method="post" autocomplete="on">
  <h1>vessel&#8202;&middot;&#8202;writer</h1>
  <!--note-->
  <input type="text" name="username" value="owner" autocomplete="username" hidden>
  <label for="t">Token</label>
  <input id="t" name="password" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Log in</button>
  <p id="err" class="note" role="alert"></p>
</form>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await fetch("api/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: document.getElementById("t").value }) });
  // On a spent login link, reloading would land on that link again; go to the app instead.
  if (r.ok) location.pathname.endsWith("/login") ? location.replace("./") : location.reload();
  else document.getElementById("err").textContent = "That token didn't match.";
});
</script>
</body></html>
"""
