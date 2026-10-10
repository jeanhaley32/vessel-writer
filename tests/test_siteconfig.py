"""The page carries this installation's names and relay, and nothing of ours.

    .venv/bin/python -m unittest discover -s tests
"""
import json
import re
import unittest

from test_auth import Server, auth


def page_config(page):
    match = re.search(r"window\.vesselConfig = (.*?);</script>", page)
    return json.loads(match.group(1))


@unittest.skipIf(auth is None, "needs the app's dependencies (run with .venv/bin/python)")
class SiteConfigTest(unittest.TestCase):
    def test_a_fresh_install_is_generic_and_has_no_relay(self):
        server = Server()
        try:
            status, page, _ = server.request("GET", "/")
            self.assertEqual(status, 200)
            self.assertEqual(page_config(page), {"owner": "You", "assistant": "Assistant", "relay": ""})
            self.assertNotIn("{{", page)
            self.assertNotIn("Rodin", page)
        finally:
            server.stop()

    def test_names_and_relay_come_from_the_environment(self):
        server = Server(env_extra={"WRITER_OWNER_NAME": "Ada", "WRITER_ASSISTANT_NAME": "Babbage",
                                   "WRITER_RELAY_CHAT": "/relaychat/"})
        try:
            _, page, _ = server.request("GET", "/")
            self.assertEqual(page_config(page), {"owner": "Ada", "assistant": "Babbage", "relay": "/relaychat"})
            self.assertIn("Chat with Babbage", page)
        finally:
            server.stop()

    def test_a_name_cannot_break_out_of_the_page(self):
        server = Server(env_extra={"WRITER_ASSISTANT_NAME": '</script><b>x</b>'})
        try:
            _, page, _ = server.request("GET", "/")
            self.assertNotIn("<b>x</b>", page)
            self.assertEqual(page_config(page)["assistant"], "</script><b>x</b>")
        finally:
            server.stop()


if __name__ == "__main__":
    unittest.main()
