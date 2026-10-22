"""A tiny Twinly API client. Python 3.9+, standard library only.

    load_env()                              read .env next to the script (never overrides real env vars)
    call("POST", "/calls", {...})           one API call; raises TwinlyError on an error
    wait_for_job(job, on_update)            wait for a job to be done, failed, canceled or expired
    explain(err)                            one line a person can act on
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE = "https://advktwnedlgnhswpxokg.supabase.co/functions/v1/twinly-api/v1"
FINISHED = {"done", "failed", "canceled", "expired"}


class TwinlyError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def load_env(path=None):
    path = path or os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), ".env")
    if not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        value = value.strip().strip("'\"")
        os.environ.setdefault(name.strip(), value)


def call(method, path, body=None):
    key = os.environ.get("TWINLY_API_KEY")
    if not key:
        raise TwinlyError(0, "missing_api_key",
                          "Set TWINLY_API_KEY in .env (Twinly > Settings > Developer API > Create a key).")
    base = (os.environ.get("TWINLY_API_BASE") or DEFAULT_BASE).rstrip("/")
    headers = {"Authorization": "Bearer " + key}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    for attempt in range(4):
        req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                return json.loads(res.read() or b"{}")  # 200, or 202 for a job that isn't finished yet
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read()).get("error") or {}
            except ValueError:
                err = {}
            code = err.get("code") or "http_error"
            # Too fast, or Twinly busy for a moment: wait as told and try again.
            if attempt < 3 and (e.code == 503 or (e.code == 429 and code == "rate_limited")):
                time.sleep(float(e.headers.get("Retry-After") or 2))
                continue
            raise TwinlyError(e.code, code, err.get("message") or "HTTP %d" % e.code)
        except urllib.error.URLError as e:
            raise TwinlyError(0, "network", "Couldn't reach %s (%s)." % (base, e.reason))


def wait_for_job(job, on_update=None):
    while job["status"] not in FINISHED:
        # The server holds this for up to 25 s and answers as soon as the job
        # finishes or its status changes, so this is one request per change.
        asked = time.time()
        latest = call("GET", "/jobs/%s?wait=25" % job["id"])
        if latest["status"] != job["status"]:
            if on_update:
                on_update(latest)
        elif time.time() - asked < 1:
            time.sleep(1)  # never hammer a server that answers at once
        job = latest
    return job


def finished(job):
    """Waits for a job and returns its result, or raises TwinlyError saying why it didn't finish."""
    job = wait_for_job(job)
    if job["status"] != "done":
        e = job.get("error") or {}
        raise TwinlyError(0, e.get("code") or job["status"], e.get("message") or "The job " + job["status"] + ".")
    return job["result"]


HINTS = {
    "twinly_offline": "Open Twinly on your Mac, sign in, and keep Settings > Developer API on.",
    "insufficient_usage": "Redeem a code in Twinly > Settings > Developer API, or add extra usage on Account.",
    "invalid_api_key": "Check TWINLY_API_KEY in .env.",
}


def explain(err):
    hint = HINTS.get(getattr(err, "code", None))
    return err.message + (" " + hint if hint else "")
