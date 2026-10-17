"""tools/migrate_k8s_track.py builds the lesson document from state.json."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import migrate_k8s_track as m  # noqa: E402

STATE = {"session": "S1", "title": "What a control plane is",
         "steps": [{"id": 1, "heading": "Three machines", "body": "No installing tonight."},
                   {"id": 2, "heading": "Deciding where", "body": "Placement needs two facts."}],
         "glossary": [{"k": "scheduler", "v": "Decides where."}],
         "dialogue": [{"who": "prof", "text": "What first?"}, {"who": "jean", "text": "resources"},
                      {"who": "prof", "text": "  "}]}


class MigrateTest(unittest.TestCase):
    def test_steps_then_terms_then_the_session(self):
        doc = m.document(STATE)
        order = [doc.index(s) for s in ("# S1 · What a control plane is", "## 1. Three machines",
                                        "## 2. Deciding where", "## Terms", "- **scheduler**: Decides where.",
                                        "## The session", "**Professor:** What first?", "**Jean:** resources")]
        self.assertEqual(order, sorted(order))

    def test_empty_turns_and_a_missing_dialogue_are_left_out(self):
        self.assertEqual(m.document(STATE).count("**Professor:**"), 1)
        self.assertNotIn("## The session", m.document({**STATE, "dialogue": []}))

    def test_there_is_no_default_target(self):
        with self.assertRaises(SystemExit):
            m.main([])


if __name__ == "__main__":
    unittest.main()
