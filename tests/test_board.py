"""Board mode storage (/api/board*), against a real server.

    .venv/bin/python -m unittest discover -s tests
"""
import json
import unittest

from test_auth import TOKEN, Server, auth


def node(i, **kw):
    return {"op": "node", "id": i, "label": kw.pop("label", i), **kw}


@unittest.skipIf(auth is None, "needs the app's dependencies (run with .venv/bin/python)")
class BoardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server(env_extra={"BOARD_OP_CAP": "12"})

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def call(self, method, path, body=None, headers=None):
        status, raw, _ = self.server.request(method, path, body, headers)
        return status, json.loads(raw)

    def append(self, path, *ops, **extra):
        return self.call("POST", "/api/board/append", {"path": path, "ops": list(ops), **extra})

    def ops(self, path):
        status, body = self.call("GET", f"/api/board?path={path}")
        self.assertEqual(status, 200)
        return body["ops"]

    def test_append_numbers_every_op_and_names_the_batch(self):
        status, body = self.append("a.md", node("x", rank=0), node("y", rank=1),
                                   {"op": "link", "from": "x", "to": "y", "label": "asks", "step": 1})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["seqs"], [1, 2, 3])
        self.assertTrue(body["batch"])
        stored = self.ops("a.md")
        self.assertEqual([o["seq"] for o in stored], [1, 2, 3])
        self.assertEqual({o["batch"] for o in stored}, {body["batch"]})

    def test_a_bad_op_refuses_the_whole_batch_and_names_it(self):
        cases = [
            ({"op": "circle"}, "unknown op"),
            ({"op": "link", "from": "p", "to": "ghost"}, "'ghost' is not a node"),
            ({"op": "emphasize", "ids": ["ghost"]}, "'ghost' is not a node"),
            (node("p"), "already on the board"),
            (node("q", label="x" * 29), "over the 28"),
            (node("q", sub="x" * 33), "over the 32"),
            ({"op": "note", "text": "x" * 91}, "over the 90"),
            (node("q", lable="typo"), "unknown field lable"),
            (node("q", kind="wizard"), "not one of"),
            ({"op": "link", "from": "p", "to": "p"}, "two different nodes"),
            ({"op": "link", "from": "p", "to": "q0", "step": 0}, "between 1 and"),
        ]
        self.assertEqual(self.append("b.md", node("p"), node("q0"))[0], 200)
        for bad, want in cases:
            status, body = self.append("b.md", node("fresh"), bad)
            self.assertEqual(status, 400, (bad, body))
            self.assertIn(want, body["detail"], bad)
            self.assertIn("op 2", body["detail"])
        self.assertEqual([o["id"] for o in self.ops("b.md")], ["p", "q0"], "a refused batch drew something")

    def test_references_count_nodes_earlier_in_the_same_batch(self):
        status, body = self.append("c.md", node("a"), {"op": "link", "from": "a", "to": "b"}, node("b"))
        self.assertEqual(status, 400, "a link before its target node was accepted")
        status, body = self.append("c.md", node("a"), node("b"), {"op": "link", "from": "a", "to": "b"},
                                   {"op": "emphasize", "ids": ["b"]})
        self.assertEqual(status, 200, body)

    def test_undo_takes_off_only_the_latest_batch(self):
        self.append("d.md", node("one"))
        _, second = self.append("d.md", node("two"), node("three"))
        status, body = self.call("POST", "/api/board/undo", {"path": "d.md"})
        self.assertEqual((status, body["batch"], body["removed"]), (200, second["batch"], 2))
        self.assertEqual([o["id"] for o in self.ops("d.md")], ["one"])
        _, third = self.append("d.md", node("four"))
        self.assertEqual(third["seqs"], [4], "a seq was reused after undo")
        self.call("POST", "/api/board/undo", {"path": "d.md"})
        self.call("POST", "/api/board/undo", {"path": "d.md"})
        status, _ = self.call("POST", "/api/board/undo", {"path": "d.md"})
        self.assertEqual(status, 404)

    def test_the_cap_refuses_a_batch_that_would_overflow(self):
        self.assertEqual(self.append("e.md", *[node(f"n{i}") for i in range(10)])[0], 200)
        status, body = self.append("e.md", node("n10"), node("n11"), node("n12"))
        self.assertEqual(status, 429)
        self.assertIn("cap is 12", body["detail"])
        self.assertEqual(len(self.ops("e.md")), 10)

    def test_clear_needs_confirm_and_refuses_a_bearer_call(self):
        self.append("f.md", node("z"))
        status, body = self.call("POST", "/api/board/clear", {"path": "f.md"})
        self.assertEqual(status, 400)
        status, body = self.call("POST", "/api/board/clear", {"path": "f.md", "confirm": True},
                                 headers={"Authorization": "Bearer anything"})
        self.assertEqual(status, 403)
        self.assertEqual(len(self.ops("f.md")), 1)
        status, body = self.call("POST", "/api/board/clear", {"path": "f.md", "confirm": True})
        self.assertEqual((status, body["removed"]), (200, 1))
        self.assertEqual(self.ops("f.md"), [])

    def test_zones_group_nodes_once_each(self):
        status, body = self.append("g.md", node("atk", kind="attacker"), node("web", kind="service"),
                                   {"op": "zone", "id": "dmz", "label": "DMZ", "ids": ["web"], "kind": "segment"},
                                   node("db", kind="data", zone="dmz"))
        self.assertEqual(status, 200, body)
        kinds = {o["id"]: o.get("kind") for o in self.ops("g.md")}
        self.assertEqual((kinds["atk"], kinds["db"]), ("actor", "state"), "kind aliases not folded")
        status, body = self.append("g.md", {"op": "zone", "id": "lan", "label": "LAN", "ids": ["web"]})
        self.assertEqual(status, 400)
        self.assertIn("already in a zone", body["detail"])
        status, body = self.append("g.md", node("x", zone="nowhere"))
        self.assertEqual(status, 400)

    def test_the_render_route_serves_the_board_page(self):
        status, raw, _ = self.server.request("GET", "/board-render?path=a.md&theme=dark")
        self.assertEqual(status, 200)
        self.assertIn('data-theme="dark"', raw)
        status, _, _ = self.server.request("GET", "/board-render?path=a.md&theme=<x>")
        self.assertEqual(status, 400)

    def test_boards_are_written_to_the_state_file(self):
        self.append("h.md", node("kept"))
        state = f"{self.server.tmp}/state/boards.json"
        with open(state) as f:
            self.assertIn("kept", f.read())


@unittest.skipIf(auth is None, "needs the app's dependencies (run with .venv/bin/python)")
class BoardAuthTest(unittest.TestCase):
    def test_board_routes_are_behind_the_login(self):
        server = Server(token=TOKEN)
        try:
            for method, path in (("GET", "/api/board?path=a.md"), ("GET", "/board-render?path=a.md"),
                                 ("POST", "/api/board/append")):
                status, _, _ = server.request(method, path, {} if method == "POST" else None)
                self.assertEqual(status, 401, path)
        finally:
            server.stop()
