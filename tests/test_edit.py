"""Anchored edits (POST /api/doc/edit), against a real server.

    .venv/bin/python -m unittest discover -s tests
"""
import base64
import json
import unittest

from test_auth import Server, auth

try:
    from pycrdt import Doc, Text
except ImportError:
    Doc = None


@unittest.skipIf(auth is None or Doc is None, "needs the app's dependencies (run with .venv/bin/python)")
class EditTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server()

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def put(self, path, content):
        status, _, _ = self.server.request("PUT", "/api/doc", {"path": path, "content": content})
        self.assertEqual(status, 200)

    def edit(self, path, *ops):
        status, body, _ = self.server.request("POST", "/api/doc/edit", {"path": path, "ops": list(ops)})
        return status, json.loads(body)

    def text(self, path, live=False):
        status, body, _ = self.server.request("GET", f"/api/doc?path={path}" + ("&collab=1" if live else ""))
        self.assertEqual(status, 200)
        return json.loads(body)["content"]

    def test_insert_after_touches_only_its_span(self):
        self.put("a.md", "# Title\n\nFirst paragraph.\n\nLast paragraph.\n")
        status, _ = self.edit("a.md", {"op": "insert_after", "anchor": "First paragraph.\n",
                                       "text": "\nA new middle paragraph.\n"})
        self.assertEqual(status, 200)
        self.assertEqual(self.text("a.md"),
                         "# Title\n\nFirst paragraph.\n\nA new middle paragraph.\n\nLast paragraph.\n")

    def test_replace_insert_before_and_append_in_one_request(self):
        self.put("b.md", "alpha beta gamma")
        status, body = self.edit("b.md",
                                 {"op": "replace", "anchor": "beta", "text": "BETA"},
                                 {"op": "insert_before", "anchor": "alpha", "text": "> "},
                                 {"op": "append", "text": "delta"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["applied"], 3)
        self.assertEqual(self.text("b.md"), "> alpha BETA gamma\ndelta")

    def test_a_missing_or_ambiguous_anchor_refuses_everything(self):
        self.put("c.md", "one two two")
        for anchor in ("three", "two"):
            status, body = self.edit("c.md", {"op": "append", "text": "x"},
                                     {"op": "insert_after", "anchor": anchor, "text": "!"})
            self.assertEqual(status, 409, body)
        self.assertEqual(self.text("c.md"), "one two two")

    def test_an_edit_may_not_replace_the_whole_document(self):
        self.put("d.md", "all of it")
        status, _ = self.edit("d.md", {"op": "replace", "anchor": "all of it", "text": "gone"})
        self.assertEqual(status, 400)
        self.assertEqual(self.text("d.md"), "all of it")

    def test_a_missing_or_deleted_document_is_not_found(self):
        status, _ = self.edit("nope.md", {"op": "append", "text": "x"})
        self.assertEqual(status, 404)
        self.put("e.md", "here")
        self.server.request("POST", "/api/delete", {"path": "e.md"})
        status, _ = self.edit("e.md", {"op": "append", "text": "x"})
        self.assertEqual(status, 404)

    def test_an_edit_keeps_what_the_owner_typed_in_an_open_tab(self):
        """The point of the feature: the owner types at the end in a live tab,
        unsaved, while Rodin inserts near the top. Both survive."""
        self.put("live.md", "Intro.\n\nBody.\n")
        _, body, _ = self.server.request("GET", "/api/doc?collab=1&path=live.md")
        seed = json.loads(body)["yseed"]
        tab = Doc()
        tab.apply_update(base64.b64decode(seed))
        text = tab.get("content", type=Text)
        before = tab.get_state()
        text.insert(len(str(text).encode()), "Typed by the owner.\n")
        update = base64.b64encode(tab.get_update(before)).decode()
        status, _, _ = self.server.request("POST", "/api/yupdate", {"path": "live.md", "update": update, "v": 2})
        self.assertEqual(status, 200)

        status, body = self.edit("live.md", {"op": "insert_after", "anchor": "Intro.\n", "text": "Added by Rodin.\n"})
        self.assertEqual(status, 200, body)
        expected = "Intro.\nAdded by Rodin.\n\nBody.\nTyped by the owner.\n"
        self.assertEqual(self.text("live.md", live=True), expected)
        self.assertEqual(self.text("live.md"), expected)


if __name__ == "__main__":
    unittest.main()
