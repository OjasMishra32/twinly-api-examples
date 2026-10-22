"""Runs meme.py against the local mock API and checks the exact picture that went out."""

import hashlib
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "meme.py")
MOCK_DIR = os.path.join(HERE, "..", "..", "mock-api")
sys.path.insert(0, MOCK_DIR)
from testkit import Mock  # noqa: E402


def read(path):
    with open(path, "rb") as f:
        return f.read()


FIXTURES = {shape: read(os.path.join(MOCK_DIR, "fixtures", "image-%s.jpg" % shape)) for shape in ("square", "wide", "tall")}


class MemeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mock = Mock()
        cls.mock.start()

    @classmethod
    def tearDownClass(cls):
        cls.mock.stop()

    def setUp(self):
        self.mock.control("reset", {})
        self.mock.config({"claim_ms": 20, "run_ms": {"messages.send": 60}})
        self.out = tempfile.mkdtemp(prefix="meme-")

    def run_script(self, *args, **env):
        return subprocess.run([sys.executable, SCRIPT, "--out", self.out, *args], env=self.mock.env(**env),
                              capture_output=True, text=True, timeout=60, cwd=HERE)

    def test_makes_the_picture_and_texts_it(self):
        r = self.run_script("--to", "Sam Lee", "a gator in a hoodie writing code at 3am")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("Made the picture:", r.stdout)
        self.assertIn("Texted it to +15555550102 (delivered).", r.stdout)

        state = self.mock.state()
        self.assertEqual([j["kind"] for j in state["jobs"]], ["messages.send"])
        sent = state["outbox"][0]
        self.assertEqual(sent["text"], "a gator in a hoodie writing code at 3am")
        pic = sent["attachments"][0]
        self.assertEqual((pic["source"], pic["received"]), ("inline", True))
        self.assertEqual((pic["name"], pic["content_type"], pic["detected"]), ("meme.jpg", "image/jpeg", "image/jpeg"))
        self.assertEqual(pic["sha256"], hashlib.sha256(FIXTURES["square"]).hexdigest())
        self.assertEqual([(c["kind"], c["credits"]) for c in state["charges"]], [("images", 0.5), ("messages.send", 0.5)])
        [saved] = os.listdir(self.out)
        self.assertEqual(read(os.path.join(self.out, saved)), FIXTURES["square"])

    def test_wide_to_a_group_with_a_caption(self):
        r = self.run_script("--chat", "Hack Squad", "our team as superheroes", "--caption", "us tomorrow", "--shape", "wide")
        self.assertEqual(r.returncode, 0, r.stderr)
        sent = self.mock.state()["outbox"][0]
        self.assertEqual((sent["chat"], sent["text"]), ("chat493021", "us tomorrow"))
        self.assertEqual(sent["attachments"][0]["sha256"], hashlib.sha256(FIXTURES["wide"]).hexdigest())

    def test_save_only_needs_no_mac(self):
        self.mock.config({"mac": "offline"})
        r = self.run_script("a cat DJ", "--save-only", "--shape", "tall")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.mock.state()["jobs"], [])
        [saved] = os.listdir(self.out)
        self.assertEqual(read(os.path.join(self.out, saved)), FIXTURES["tall"])

    def test_no_recipient_is_caught_before_spending_anything(self):
        r = self.run_script("a cat DJ")
        self.assertEqual(r.returncode, 2)
        self.assertIn("--to or --chat", r.stderr)
        self.assertEqual(self.mock.state()["charges"], [])

    def test_out_of_usage(self):
        self.mock.config({"balance_credits": 0})
        r = self.run_script("--to", "Mom", "a cat DJ")
        self.assertEqual(r.returncode, 1)
        self.assertIn("doesn't have enough usage", r.stderr)

    def test_key_without_images_scope(self):
        key = self.mock.control("keys", {"scopes": ["messages.send"]})["key"]
        r = self.run_script("--to", "Mom", "a cat DJ", TWINLY_API_KEY=key)
        self.assertEqual(r.returncode, 1)
        self.assertIn("'images' scope", r.stderr)


if __name__ == "__main__":
    unittest.main()
