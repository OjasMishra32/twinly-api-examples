"""Runs call_agent.py against the local mock API and checks what you'd see."""

import os
import signal
import subprocess
import sys
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "call_agent.py")
sys.path.insert(0, os.path.join(HERE, "..", "..", "mock-api"))
from testkit import Mock, eventually  # noqa: E402

FAST = {"claim_ms": 20, "run_ms": {"calls.place": 300}}


class CallAgentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mock = Mock()
        cls.mock.start()

    @classmethod
    def tearDownClass(cls):
        cls.mock.stop()

    def setUp(self):
        self.mock.control("reset", {})
        self.mock.config(FAST)

    def run_script(self, *args, **env):
        return subprocess.run([sys.executable, SCRIPT, *args], env=self.mock.env(**env),
                              capture_output=True, text=True, timeout=60, cwd=HERE)

    def test_places_the_call_and_prints_the_transcript(self):
        r = self.run_script("--to", "Bella's Bistro", "--goal", "Book a table for 2 at 7pm")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertRegex(r.stdout, r"Calling Bella's Bistro \(job [0-9a-f-]{36}\)\.")
        self.assertIn("On the call now...", r.stdout)
        self.assertIn("  Them: Hi, thanks for calling. How can I help you?", r.stdout)
        self.assertIn("  Twin: Hi! I'm calling to book a table for 2 at 7pm.", r.stdout)
        self.assertIn("Outcome: Done: Book a table for 2 at 7pm (mock call, no phone was used).", r.stdout)
        self.assertIn("Length: 1 minute", r.stdout)
        state = self.mock.state()
        self.assertEqual(len(state["calls"]), 1)
        self.assertEqual(state["calls"][0]["to"], "+15555550199")
        self.assertEqual(state["jobs"][0]["payload"], {"to": "Bella's Bistro", "goal": "Book a table for 2 at 7pm"})
        self.assertEqual([(c["kind"], c["credits"]) for c in state["charges"]], [("calls.place", 3)])
        # One POST, then one long-poll per status change (queued -> running -> done): no polling.
        self.assertEqual(state["keys"][0]["requests"], 3)

    def test_say_sets_the_opening_line(self):
        r = self.run_script("--to", "+1 (555) 555-0199", "--goal", "Ask about vegan options", "--say", "Hi! Quick question.")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("  Twin: Hi! Quick question.", r.stdout)
        self.assertEqual(self.mock.state()["calls"][0]["to"], "+15555550199")

    def test_waits_for_the_owner_to_approve(self):
        self.mock.config({"hold": ["calls.place"]})
        out = []
        with subprocess.Popen([sys.executable, SCRIPT, "--to", "Mom", "--goal", "Say happy birthday"],
                              env=self.mock.env(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True) as proc:
            reader = threading.Thread(target=lambda: out.extend(proc.stdout), daemon=True)
            reader.start()
            # Approve only once the script has told the person it's waiting, like a real owner would.
            eventually(lambda: any("waiting for you to approve" in line for line in out))
            held = [j for j in self.mock.state()["jobs"] if j["status"] == "needs_approval"][0]
            self.mock.control("jobs/%s/decide" % held["id"], {"approve": True})
            self.assertEqual(proc.wait(30), 0)
            reader.join(5)
        self.assertIn("Outcome: Done: Say happy birthday", "".join(out))

    def interrupt_once(self, wait_for_line):
        out = []
        with subprocess.Popen([sys.executable, SCRIPT, "--to", "Mom", "--goal", "Say hi"], env=self.mock.env(),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as proc:
            reader = threading.Thread(target=lambda: out.extend(proc.stdout), daemon=True)
            reader.start()
            eventually(lambda: any(wait_for_line in line for line in out))
            proc.send_signal(signal.SIGINT)
            code = proc.wait(30)
            err = proc.stderr.read()
            reader.join(5)
        return code, err

    def test_ctrl_c_cancels_a_call_still_in_line(self):
        self.mock.config({"mac": "paused"})
        code, err = self.interrupt_once("Calling Mom")
        self.assertEqual(code, 130)
        self.assertIn("Canceled.", err)
        self.assertEqual(self.mock.state()["jobs"][0]["status"], "canceled")

    def test_ctrl_c_on_a_call_under_way_asks_the_mac_to_hang_up(self):
        self.mock.config({"hold": ["calls.place"]})
        code, err = self.interrupt_once("waiting for you to approve")
        self.assertEqual(code, 130)
        self.assertIn("Asked your Twinly to hang up", err)

    def test_offline_mac(self):
        self.mock.config({"mac": "offline"})
        r = self.run_script("--to", "Mom", "--goal", "Say hi")
        self.assertEqual(r.returncode, 1)
        self.assertIn("Your Twinly isn't running", r.stderr)
        self.assertEqual(self.mock.state()["jobs"], [])

    def test_not_enough_usage(self):
        self.mock.config({"balance_credits": 2})
        r = self.run_script("--to", "Mom", "--goal", "Say hi")
        self.assertEqual(r.returncode, 1)
        self.assertIn("doesn't have enough usage", r.stderr)
        self.assertIn("Redeem a code", r.stderr)

    def test_unknown_contact_fails_cleanly_and_costs_nothing(self):
        r = self.run_script("--to", "Somebody Unknown", "--goal", "Say hi")
        self.assertEqual(r.returncode, 1)
        self.assertIn("The call failed: Twinly couldn't find \"Somebody Unknown\"", r.stderr)
        self.assertEqual(self.mock.state()["charges"], [])

    def test_key_without_calls_scope(self):
        key = self.mock.control("keys", {"scopes": ["chat"]})["key"]
        r = self.run_script("--to", "Mom", "--goal", "Say hi", TWINLY_API_KEY=key)
        self.assertEqual(r.returncode, 1)
        self.assertIn("'calls' scope", r.stderr)


if __name__ == "__main__":
    unittest.main()
