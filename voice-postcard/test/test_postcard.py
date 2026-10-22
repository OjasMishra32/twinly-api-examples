"""Runs postcard.py against the local mock API and checks the exact audio that went out."""

import hashlib
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "postcard.py")
MOCK_DIR = os.path.join(HERE, "..", "..", "mock-api")
sys.path.insert(0, MOCK_DIR)
from testkit import Mock, eventually  # noqa: E402



def read(path):
    with open(path, "rb") as f:
        return f.read()


FIXTURE = read(os.path.join(MOCK_DIR, "fixtures", "voice.m4a"))


class PostcardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mock = Mock()
        cls.mock.start()

    @classmethod
    def tearDownClass(cls):
        cls.mock.stop()

    def setUp(self):
        self.mock.control("reset", {})
        self.mock.config({"claim_ms": 20, "run_ms": {"voice.speak": 60, "messages.send": 60}})
        self.out = tempfile.mkdtemp(prefix="postcard-")

    def run_script(self, *args, **env):
        return subprocess.run([sys.executable, SCRIPT, "--out", self.out, *args], env=self.mock.env(**env),
                              capture_output=True, text=True, timeout=60, cwd=HERE)

    def saved_files(self):
        return [os.path.join(self.out, f) for f in os.listdir(self.out)]

    def test_speaks_then_texts_the_audio(self):
        r = self.run_script("--to", "Mom", "--say", "Happy birthday! Wish I could be there.")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("Recorded 1.2 seconds in your voice", r.stdout)
        self.assertIn("Sent to +15555550101 (delivered).", r.stdout)

        state = self.mock.state()
        self.assertEqual([j["kind"] for j in state["jobs"]], ["voice.speak", "messages.send"])
        self.assertEqual(state["jobs"][0]["payload"], {"text": "Happy birthday! Wish I could be there."})
        sent = state["outbox"][0]
        self.assertEqual(sent["to"], "+15555550101")
        self.assertEqual(sent["text"], "I made you a voice postcard.")
        audio = sent["attachments"][0]
        self.assertEqual((audio["source"], audio["received"]), ("inline", True))
        self.assertEqual(audio["name"], "postcard.m4a")
        self.assertEqual(audio["content_type"], "audio/mp4")
        self.assertEqual(audio["detected"], "audio/mp4")
        self.assertEqual(audio["sha256"], hashlib.sha256(FIXTURE).hexdigest())
        self.assertEqual([(c["kind"], c["credits"]) for c in state["charges"]], [("voice.speak", 1), ("messages.send", 0.5)])

        [saved] = self.saved_files()
        self.assertEqual(read(saved), FIXTURE)

    def test_to_a_group_with_a_caption(self):
        r = self.run_script("--chat", "Hack Squad", "--say", "We won!", "--caption", "Listen to this")
        self.assertEqual(r.returncode, 0, r.stderr)
        sent = self.mock.state()["outbox"][0]
        self.assertEqual((sent["chat"], sent["text"]), ("chat493021", "Listen to this"))

    def test_save_only_sends_nothing(self):
        r = self.run_script("--say", "Testing my voice", "--save-only")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual([j["kind"] for j in self.mock.state()["jobs"]], ["voice.speak"])
        self.assertEqual(len(self.saved_files()), 1)

    def test_no_recipient_is_caught_before_spending_anything(self):
        r = self.run_script("--say", "hi")
        self.assertEqual(r.returncode, 2)
        self.assertIn("--to or --chat", r.stderr)
        self.assertEqual(self.mock.state()["jobs"], [])

    def test_too_long_is_refused_by_the_api(self):
        r = self.run_script("--to", "Mom", "--say", "la " * 300)
        self.assertEqual(r.returncode, 1)
        self.assertIn("text is limited to 600 characters", r.stderr)

    def test_offline_mac(self):
        self.mock.config({"mac": "offline"})
        r = self.run_script("--to", "Mom", "--say", "hi")
        self.assertEqual(r.returncode, 1)
        self.assertIn("Your Twinly isn't running", r.stderr)

    def test_job_unverified_is_never_sent_twice(self):
        # The text's POST makes the job but its answer is lost (503
        # job_unverified). The job still runs, so the client must not send it
        # again: exactly one text goes out.
        self.mock.config({"unverify_jobs": 1, "unverify_kind": "messages.send"})
        r = self.run_script("--to", "Mom", "--say", "hi")
        self.assertEqual(r.returncode, 1)
        self.assertIn("couldn't confirm this job was created", r.stderr)
        self.assertIn("Don't send it again yet", r.stderr)
        kinds = [j["kind"] for j in self.mock.state()["jobs"]]
        self.assertEqual(kinds, ["voice.speak", "messages.send"], "one POST each, no retry")
        eventually(lambda: len(self.mock.state()["outbox"]) == 1)
        self.assertEqual(len(self.mock.state()["outbox"]), 1)


if __name__ == "__main__":
    unittest.main()
