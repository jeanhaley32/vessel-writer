"""Storage-layer tests. Plain unittest, stdlib only:

    python3 -m unittest discover -s tests
"""
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from blobstore import BlobStore
from vfs import VFS


def live_paths(vfs):
    return sorted(d["path"] for d in vfs.tree())


class VFSTest(unittest.TestCase):
    def setUp(self):
        self.vfs = VFS(tempfile.mkdtemp())
        self.addCleanup(self.vfs.close)

    def test_writing_to_a_deleted_path_brings_it_back(self):
        self.vfs.save("a.md", "one")
        self.vfs.delete("a.md")
        res = self.vfs.save("a.md", "two")
        self.assertTrue(res["revived"])
        self.assertEqual(live_paths(self.vfs), ["a.md"])
        self.assertEqual(self.vfs.tombstones(), [])
        self.assertEqual(self.vfs.read("a.md")["content"], "two")

    def test_rewriting_identical_content_over_a_deleted_path_revives_it(self):
        self.vfs.save("a.md", "same")
        self.vfs.delete("a.md")
        self.assertTrue(self.vfs.save("a.md", "same")["revived"])
        self.assertEqual(live_paths(self.vfs), ["a.md"])

    def test_removing_a_folder_leaves_a_lookalike_alone(self):
        # '_' is a LIKE wildcard; 'a_b' must not match 'axb'
        self.vfs.save("a_b/x.md", "1")
        self.vfs.save("axb/y.md", "2")
        self.vfs.mkdir("a_b")
        self.vfs.mkdir("axb")
        res = self.vfs.rmdir("a_b", recursive=True)
        self.assertEqual(res["deleted_docs"], ["a_b/x.md"])
        self.assertEqual(live_paths(self.vfs), ["axb/y.md"])
        self.assertIn("axb", self.vfs.folders())

    def test_moving_a_folder_leaves_a_lookalike_alone(self):
        self.vfs.save("a%/x.md", "1")
        self.vfs.save("abc/y.md", "2")
        self.vfs.mkdir("a%")
        self.vfs.mkdir("abc")
        self.vfs.move("a%", "moved")
        self.assertEqual(live_paths(self.vfs), ["abc/y.md", "moved/x.md"])

    def test_move_refuses_to_overwrite(self):
        self.vfs.save("a.md", "a")
        self.vfs.save("b.md", "b")
        with self.assertRaises(ValueError):
            self.vfs.move("a.md", "b.md")
        self.assertEqual(live_paths(self.vfs), ["a.md", "b.md"])

    def test_move_refuses_a_tombstoned_destination(self):
        self.vfs.save("a.md", "a")
        self.vfs.save("b.md", "b")
        self.vfs.delete("b.md")
        with self.assertRaises(ValueError):
            self.vfs.move("a.md", "b.md")
        self.assertEqual(live_paths(self.vfs), ["a.md"])

    def test_move_of_nothing_is_an_error(self):
        with self.assertRaises(ValueError):
            self.vfs.move("ghost.md", "real.md")

    def test_a_folder_cannot_move_into_itself(self):
        self.vfs.save("f/x.md", "1")
        self.vfs.mkdir("f")
        with self.assertRaises(ValueError):
            self.vfs.move("f", "f/inner")
        self.assertEqual(live_paths(self.vfs), ["f/x.md"])

    def test_a_refused_move_leaves_nothing_half_done(self):
        self.vfs.save("f/x.md", "1")
        self.vfs.save("g/x.md", "2")
        self.vfs.mkdir("f")
        self.vfs.mkdir("g")
        with self.assertRaises(ValueError):
            self.vfs.move("f", "g")
        self.assertEqual(live_paths(self.vfs), ["f/x.md", "g/x.md"])
        self.assertEqual(self.vfs.folders(), ["f", "g"])

    def test_concurrent_saves_do_not_corrupt_the_index(self):
        errors = []

        def writer(n):
            try:
                for i in range(25):
                    self.vfs.save(f"doc{n}.md", f"{n}:{i}")
            except Exception as exc:       # noqa: BLE001 - the test reports any failure
                errors.append(exc)

        threads = [threading.Thread(target=writer, args=(n,)) for n in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertEqual(len(live_paths(self.vfs)), 6)

    def test_version_content_serves_only_this_documents_versions(self):
        self.vfs.save("a.md", "secret")
        other = self.vfs.save("b.md", "other")["hash"]
        self.assertIsNone(self.vfs.version_content("a.md", other))


class BlobStoreTest(unittest.TestCase):
    def test_a_digest_that_is_not_a_digest_never_becomes_a_path(self):
        store = BlobStore(tempfile.mkdtemp())
        for bad in ("../../etc/passwd", "abc", "g" * 64, ""):
            with self.assertRaises(ValueError):
                store.get(bad)

    def test_round_trip(self):
        store = BlobStore(tempfile.mkdtemp())
        self.assertEqual(store.get(store.put(b"hello")), b"hello")


if __name__ == "__main__":
    unittest.main()
