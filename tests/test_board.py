"""Board mode storage (/api/board*), against a real server.

    .venv/bin/python -m unittest discover -s tests
"""
import json
import time
import unittest
from pathlib import Path

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
class NamedBoardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server(env_extra={"BOARD_CAP": "4"})

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    call = BoardTest.call

    def append(self, path, board, *ops):
        body = {"path": path, "ops": list(ops)}
        if board is not None:
            body["board"] = board
        return self.call("POST", "/api/board/append", body)

    def board(self, path, board=None):
        q = f"/api/board?path={path}" + (f"&board={board.replace(' ', '%20')}" if board else "")
        status, body = self.call("GET", q)
        self.assertEqual(status, 200, body)
        return body

    def listing(self, path):
        status, body = self.call("GET", f"/api/board/list?path={path}")
        self.assertEqual(status, 200, body)
        return [(b["name"], b["count"], b["exists"]) for b in body["boards"]]

    def test_an_unnamed_call_is_main_and_a_named_one_is_its_own_board(self):
        self.assertEqual(self.append("n1.md", None, node("a"))[0], 200)
        status, body = self.append("n1.md", "attack path", node("a"), node("b"))
        self.assertEqual(status, 200, body)
        self.assertEqual((body["board"], body["seqs"]), ("attack path", [1, 2]), "seqs are not per board")
        self.assertEqual([o["id"] for o in self.board("n1.md")["ops"]], ["a"])
        self.assertEqual(self.board("n1.md", "main")["board"], "main")
        self.assertEqual([o["id"] for o in self.board("n1.md", "attack path")["ops"]], ["a", "b"])
        self.assertEqual(self.listing("n1.md"), [("main", 1, True), ("attack path", 2, True)])

    def test_list_always_has_main_and_a_read_creates_nothing(self):
        self.assertEqual(self.listing("n2.md"), [("main", 0, False)])
        body = self.board("n2.md", "later")
        self.assertEqual((body["ops"], body["exists"]), ([], False))
        self.assertEqual(self.listing("n2.md"), [("main", 0, False)])

    def test_board_names_are_checked(self):
        for bad in ("", " ", "x" * 25, "a/b", "<script>", "über", 7):
            if bad in ("", " "):
                continue                      # empty means main, see above
            status, body = self.append("n3.md", bad, node("a"))
            self.assertEqual(status, 400, (bad, body))
            self.assertIn("board name", body["detail"])
        self.assertEqual(self.append("n3.md", "  Lab_2 - net ", node("a"))[1]["board"], "Lab_2 - net")
        status, body = self.append("n3.md", "lab_2 - NET", node("b"))
        self.assertEqual(status, 400)
        self.assertIn("only in case", body["detail"])
        status, body = self.append("n3.md", "Main", node("b"))
        self.assertEqual(status, 400, "a board shadowing main by case was made")
        self.assertEqual(self.listing("n3.md"), [("main", 0, False), ("Lab_2 - net", 1, True)])

    def test_the_board_cap_counts_main_and_refuses_the_next_new_board(self):
        for name in ("b1", "b2", "b3"):
            self.assertEqual(self.append("n4.md", name, node("a"))[0], 200)
        status, body = self.append("n4.md", "b4", node("a"))
        self.assertEqual(status, 429, body)
        self.assertIn("cap is 4", body["detail"])
        self.assertEqual(self.append("n4.md", "b1", node("more"))[0], 200, "an existing board was capped")
        self.assertEqual(self.append("n4.md", None, node("a"))[0], 200, "main was capped")

    def test_undo_and_clear_touch_only_the_named_board(self):
        self.append("n5.md", None, node("m"))
        self.append("n5.md", "two", node("t1"))
        self.append("n5.md", "two", node("t2"))
        status, body = self.call("POST", "/api/board/undo", {"path": "n5.md", "board": "two"})
        self.assertEqual((status, body["board"], body["removed"]), (200, "two", 1))
        self.assertEqual([o["id"] for o in self.board("n5.md", "two")["ops"]], ["t1"])
        self.assertEqual(len(self.board("n5.md")["ops"]), 1)
        status, _ = self.call("POST", "/api/board/undo", {"path": "n5.md", "board": "ghost"})
        self.assertEqual(status, 404)
        status, body = self.call("POST", "/api/board/clear", {"path": "n5.md", "board": "two", "confirm": True})
        self.assertEqual((status, body["removed"]), (200, 1))
        self.assertEqual(self.listing("n5.md"), [("main", 1, True), ("two", 0, True)], "clear removed the tab")
        status, _ = self.call("POST", "/api/board/clear", {"path": "n5.md", "board": "ghost", "confirm": True})
        self.assertEqual(status, 404, "clear made a board")

    def test_delete_is_the_owners_and_main_can_only_be_cleared(self):
        self.append("n6.md", None, node("m"))
        self.append("n6.md", "scratch", node("s"))
        status, _ = self.call("POST", "/api/board/delete", {"path": "n6.md", "board": "scratch"})
        self.assertEqual(status, 400, "delete without confirm")
        status, _ = self.call("POST", "/api/board/delete", {"path": "n6.md", "board": "scratch", "confirm": True},
                              headers={"Authorization": "Bearer anything"})
        self.assertEqual(status, 403, "a bearer call deleted a board")
        for board in ("main", None):
            body = {"path": "n6.md", "confirm": True, **({"board": board} if board else {})}
            status, resp = self.call("POST", "/api/board/delete", body)
            self.assertEqual(status, 400, board)
            self.assertIn("only cleared", resp["detail"])
        status, _ = self.call("POST", "/api/board/delete", {"path": "n6.md", "board": "ghost", "confirm": True})
        self.assertEqual(status, 404)
        status, body = self.call("POST", "/api/board/delete", {"path": "n6.md", "board": "scratch", "confirm": True})
        self.assertEqual((status, body["removed"]), (200, 1))
        self.assertEqual(self.listing("n6.md"), [("main", 1, True)])

    def test_events_name_their_board(self):
        import threading, urllib.request
        events = []

        def listen():
            with urllib.request.urlopen(self.server.base + "/api/board/stream", timeout=10) as resp:
                for raw in resp:
                    line = raw.decode().strip()
                    if line.startswith("data: "):
                        events.append(json.loads(line[6:]))
                        if len(events) == 4:
                            return

        t = threading.Thread(target=listen, daemon=True)
        t.start()
        time.sleep(0.5)
        self.append("n7.md", "side", node("a"))
        self.call("POST", "/api/board/undo", {"path": "n7.md", "board": "side"})
        self.call("POST", "/api/board/clear", {"path": "n7.md", "board": "side", "confirm": True})
        self.call("POST", "/api/board/delete", {"path": "n7.md", "board": "side", "confirm": True})
        t.join(10)
        self.assertEqual([(e["type"], e.get("board")) for e in events],
                         [("append", "side"), ("undo", "side"), ("clear", "side"), ("deleted", "side")])

    def test_boards_follow_their_document_on_move(self):
        self.assertEqual(self.call("PUT", "/api/doc", {"path": "n8.md", "content": "x"})[0], 200)
        self.append("n8.md", None, node("m"))
        self.append("n8.md", "other", node("o"))
        status, body = self.call("POST", "/api/move", {"old": "n8.md", "new": "n8b.md"})
        self.assertEqual(status, 200, body)
        self.assertEqual(self.listing("n8b.md"), [("main", 1, True), ("other", 1, True)])
        self.assertEqual(self.listing("n8.md"), [("main", 0, False)])

    def test_the_render_route_takes_a_board(self):
        status, raw, _ = self.server.request("GET", "/board-render?path=a.md&board=attack%20path")
        self.assertEqual(status, 200)
        self.assertIn('window.boardRenderBoard = "attack path"', raw)
        status, raw, _ = self.server.request("GET", "/board-render?path=a.md")
        self.assertIn('window.boardRenderBoard = "main"', raw)
        status, _, _ = self.server.request("GET", "/board-render?path=a.md&board=%3Cx%3E")
        self.assertEqual(status, 400)


# The shape boards.json had before boards had names: by_path[path] was the
# board. Seq 3 was undone (next_seq 5 with seqs 1, 2, 4), as on a live board.
OLD_SHAPE = {"by_path": {
    "learn/old.md": {"next_seq": 5, "ops": [
        {"op": "node", "id": "api", "label": "API server", "rank": 0, "order": 0, "kind": "service",
         "seq": 1, "batch": "aaaaaaaaaaaa", "at": 1760000000.5, "batch_label": "from /k8s-track/"},
        {"op": "node", "id": "etcd", "label": "etcd", "rank": 1, "order": 0, "kind": "state",
         "seq": 2, "batch": "aaaaaaaaaaaa", "at": 1760000000.5, "batch_label": "from /k8s-track/"},
        {"op": "link", "from": "api", "to": "etcd", "label": "writes", "step": 1,
         "seq": 4, "batch": "bbbbbbbbbbbb", "at": 1760000100.0}]},
    "empty.md": {"next_seq": 3, "ops": []},
}}


@unittest.skipIf(auth is None, "needs the app's dependencies (run with .venv/bin/python)")
class BoardMigrationTest(unittest.TestCase):
    def test_a_one_board_state_file_loads_as_main_with_every_op_intact(self):
        server = Server(state={"boards": OLD_SHAPE})
        try:
            for path, old in OLD_SHAPE["by_path"].items():
                status, raw, _ = server.request("GET", f"/api/board?path={path}")
                body = json.loads(raw)
                self.assertEqual((status, body["board"], body["exists"]), (200, "main", True), path)
                self.assertEqual(body["ops"], old["ops"], f"{path}: ops changed in the move")
                _, raw, _ = server.request("GET", f"/api/board/list?path={path}")
                self.assertEqual([b["name"] for b in json.loads(raw)["boards"]], ["main"])
            # the next append carries on from the old next_seq: seq 3, once undone, is not reused
            status, raw, _ = server.request("POST", "/api/board/append",
                                            {"path": "learn/old.md", "ops": [node("sched", rank=2)]})
            self.assertEqual((status, json.loads(raw)["seqs"]), (200, [5]))
            state = Path(server.tmp) / "state"
            saved = json.loads((state / "boards.json").read_text())
            self.assertEqual(saved["version"], 2)
            self.assertEqual(saved["by_path"]["learn/old.md"]["main"]["ops"][:3], OLD_SHAPE["by_path"]["learn/old.md"]["ops"])
            self.assertEqual(json.loads((state / "boards-v1.json").read_text()), OLD_SHAPE,
                             "the old file was not kept for going back")
        finally:
            server.stop()

    def test_a_migrated_file_is_not_migrated_again(self):
        server = Server(state={"boards": OLD_SHAPE})
        try:
            server.request("POST", "/api/board/append", {"path": "learn/old.md", "board": "two", "ops": [node("x")]})
        finally:
            server.stop()
        state = Path(server.tmp) / "state"
        after_first = (state / "boards.json").read_text()
        again = Server(env_extra={"WRITER_STATE_DIR": str(state)})
        try:
            _, raw, _ = again.request("GET", "/api/board/list?path=learn/old.md")
            self.assertEqual([(b["name"], b["count"]) for b in json.loads(raw)["boards"]], [("main", 3), ("two", 1)])
        finally:
            again.stop()
        self.assertEqual((state / "boards.json").read_text(), after_first, "a second load rewrote the file")


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
