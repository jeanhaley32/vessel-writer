"""Owner-token auth, against a real server process.

Needs the app's dependencies, so run it with the project's venv:

    .venv/bin/python -m unittest discover -s tests
"""
import http.cookiejar
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "backend"))

try:
    import auth
except ImportError:          # no fastapi on this interpreter
    auth = None

TOKEN = "correct-horse-battery-staple"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, token=None, env_extra=None):
        self.tmp = tempfile.mkdtemp()
        self.port = free_port()
        env = {k: v for k, v in os.environ.items() if not k.startswith(("INGEST_", "WRITER_"))}
        env.update(WRITER_ROOT=f"{self.tmp}/root", WRITER_STATE_DIR=f"{self.tmp}/state",
                   WRITER_TOKEN_FILE=f"{self.tmp}/no-token-file", WRITER_CLIENTLOG=f"{self.tmp}/client.log",
                   ACTIVITY_PROJECT_DIR=f"{self.tmp}/transcripts")
        if token:
            env["WRITER_TOKEN"] = token
        env.update(env_extra or {})
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app:app", "--app-dir", str(REPO / "backend"),
             "--host", "127.0.0.1", "--port", str(self.port)],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.base = f"http://127.0.0.1:{self.port}"
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=0.2).close()
                return
            except OSError:
                time.sleep(0.1)
        self.stop()
        raise RuntimeError("server did not start")

    def stop(self):
        self.proc.terminate()
        self.proc.wait(timeout=10)

    def request(self, method, path, body=None, headers=None, opener=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with (opener or urllib.request.build_opener()).open(req) as resp:
                return resp.status, resp.read().decode(), resp.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode(), e.headers


def with_cookies():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


@unittest.skipIf(auth is None, "needs the app's dependencies (run with .venv/bin/python)")
class AuthOffTest(unittest.TestCase):
    def test_without_a_token_everything_is_open_as_before(self):
        server = Server()
        try:
            status, _, _ = server.request("GET", "/api/structure")
            self.assertEqual(status, 200)
        finally:
            server.stop()


@unittest.skipIf(auth is None, "needs the app's dependencies (run with .venv/bin/python)")
class AuthOnTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server(token=TOKEN)

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def test_the_api_refuses_an_anonymous_caller(self):
        for method, path in (("GET", "/api/structure"), ("GET", "/api/doc?path=a.md"),
                             ("GET", "/api/comments/stream"), ("GET", "/static/app.js")):
            status, _, _ = self.server.request(method, path)
            self.assertEqual(status, 401, f"{method} {path}")

    def test_the_app_page_becomes_the_login_form(self):
        status, body, _ = self.server.request("GET", "/")
        self.assertEqual(status, 401)
        self.assertIn('type="password"', body)
        self.assertNotIn("static/app.js", body)

    def test_the_bearer_token_opens_the_api(self):
        status, _, _ = self.server.request("GET", "/api/structure", headers={"Authorization": f"Bearer {TOKEN}"})
        self.assertEqual(status, 200)

    def test_a_wrong_bearer_token_does_not(self):
        status, _, _ = self.server.request("GET", "/api/structure", headers={"Authorization": "Bearer nope"})
        self.assertEqual(status, 401)

    def test_logging_in_sets_a_cookie_that_opens_the_app(self):
        opener = with_cookies()
        status, _, headers = self.server.request("POST", "/api/login", {"token": TOKEN}, opener=opener)
        self.assertEqual(status, 200)
        cookie = headers.get("set-cookie", "")
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=strict", cookie)
        self.assertNotIn(TOKEN, cookie)
        status, body, _ = self.server.request("GET", "/", opener=opener)
        self.assertEqual(status, 200)
        self.assertIn("static/app.js", body)

    def test_logging_in_from_a_spent_link_leaves_the_link(self):
        _, page, _ = self.server.request("GET", "/login?code=spent")
        self.assertIn('location.pathname.endsWith("/login")', page)
        self.assertIn('location.replace("./")', page)

    def test_a_wrong_token_does_not_log_in(self):
        status, _, headers = self.server.request("POST", "/api/login", {"token": "guess"})
        self.assertEqual(status, 401)
        self.assertNotIn("vw_session", headers.get("set-cookie", ""))

    def test_a_login_link_needs_auth_to_make_and_works_once(self):
        status, _, _ = self.server.request("POST", "/api/login-link")
        self.assertEqual(status, 401)
        status, body, _ = self.server.request("POST", "/api/login-link",
                                              headers={"Authorization": f"Bearer {TOKEN}"})
        self.assertEqual(status, 200)
        link = "/" + json.loads(body)["path"]
        opener = with_cookies()
        status, page, headers = self.server.request("GET", link, opener=opener)
        self.assertEqual(status, 200)
        self.assertIn('location.replace("./")', page)
        self.assertIn("SameSite=strict", headers.get("set-cookie", ""))
        status, page, _ = self.server.request("GET", "/", opener=opener)
        self.assertEqual(status, 200)            # the page's own navigation, now signed in
        self.assertIn("static/app.js", page)
        status, page, _ = self.server.request("GET", link)
        self.assertEqual(status, 401)
        self.assertIn("expired or was already used", page)


@unittest.skipIf(auth is None, "needs the app's dependencies (run with .venv/bin/python)")
class BindTest(unittest.TestCase):
    def setUp(self):
        self.saved = os.environ.pop("WRITER_TOKEN", None)
        self.saved_file = auth.TOKEN_FILE
        auth.TOKEN_FILE = Path(tempfile.mkdtemp()) / "absent"

    def tearDown(self):
        auth.TOKEN_FILE = self.saved_file
        if self.saved is not None:
            os.environ["WRITER_TOKEN"] = self.saved

    def test_loopback_without_a_token_is_allowed(self):
        for host in ("127.0.0.1", "::1", "localhost"):
            auth.check_bind(host)

    def test_anything_else_without_a_token_refuses_to_start(self):
        for host in ("0.0.0.0", "192.0.2.1", "example.test"):
            with self.assertRaises(SystemExit):
                auth.check_bind(host)

    def test_a_token_permits_any_bind(self):
        os.environ["WRITER_TOKEN"] = TOKEN
        try:
            auth.check_bind("0.0.0.0")
        finally:
            del os.environ["WRITER_TOKEN"]


if __name__ == "__main__":
    unittest.main()
