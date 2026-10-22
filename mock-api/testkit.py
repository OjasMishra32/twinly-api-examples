"""Starts the mock API in a child process for a Python test.

    from testkit import Mock
    with Mock(config={"hold": ["calls.place"]}) as mock:
        env = mock.env()            # TWINLY_API_BASE + TWINLY_API_KEY for the example
        ... run the example ...
        state = mock.state()

Needs Node 20+ on PATH (the mock is one Node file). Standard library only.
"""

import json
import os
import subprocess
import tempfile
import threading
import time
import urllib.request

SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.js")


class Mock:
    def __init__(self, args=None, config=None):
        self.args = list(args or [])
        self.initial_config = config
        self.proc = None
        self.info = None

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *exc):
        self.stop()

    def start(self):
        self.errors = tempfile.TemporaryFile(mode="w+")
        self.proc = subprocess.Popen(
            ["node", SERVER, "--port", "0", "--fast", *self.args],
            stdout=subprocess.PIPE,
            stderr=self.errors,
            text=True,
        )
        found = {}

        def read():
            for line in self.proc.stdout:
                if line.startswith("MOCK_API_READY "):
                    found["info"] = json.loads(line[len("MOCK_API_READY "):])
                    break

        t = threading.Thread(target=read, daemon=True)
        t.start()
        t.join(10)
        if "info" not in found:
            self.proc.kill()
            self.proc.wait()
            self.errors.seek(0)
            raise RuntimeError("mock API didn't start: " + self.errors.read())
        self.info = found["info"]
        # Keep draining stdout so the child never blocks on a full pipe.
        threading.Thread(target=lambda: [None for _ in self.proc.stdout], daemon=True).start()
        if self.initial_config:
            self.config(self.initial_config)

    def stop(self):
        if not self.proc:
            return
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.proc.stdout.close()
        self.errors.close()

    @property
    def url(self):
        return self.info["url"]

    @property
    def base(self):
        return self.info["base"]

    @property
    def key(self):
        return self.info["key"]

    def env(self, **extra):
        env = dict(os.environ)
        env.update({
            "TWINLY_API_BASE": self.base,
            "TWINLY_API_KEY": self.key,
            "PYTHONUNBUFFERED": "1",
        })
        env.update({k: str(v) for k, v in extra.items()})
        return env

    def control(self, route, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            self.url + "/_mock/" + route.lstrip("/"),
            data=data,
            method="GET" if body is None else "POST",
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as res:
            return json.loads(res.read())

    def state(self):
        return self.control("state")

    def config(self, cfg):
        return self.control("config", cfg)


def eventually(fn, timeout=5.0, every=0.05):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(every)
    raise AssertionError("timed out waiting (last value: %r)" % (last,))
