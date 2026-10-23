#!/usr/bin/env python3
"""Have your Twinly make a phone call for you, in your cloned voice.

    python3 call_agent.py --to "+1 352 555 0199" --goal "Book a table for 2 at 7pm tonight"
    python3 call_agent.py --to "Bella's Bistro" --goal "Ask if they have vegan options" --say "Hi! Quick question."

It places the call through your own Twinly on your Mac, waits while the call
happens, then prints the whole conversation and how it went.
"""

import argparse
import sys

from twinly import TwinlyError, call, explain, load_env, wait_for_job

STATUS = {
    "running": "On the call now...",
    "needs_approval": "Twinly is waiting for you to approve the call in the app on your Mac.",
}


def show(job):
    if job["status"] in STATUS:
        print(STATUS[job["status"]])


def main():
    load_env()
    p = argparse.ArgumentParser(description="Place a call with your Twinly and print the transcript.")
    p.add_argument("--to", required=True, help="a phone number or a contact's name")
    p.add_argument("--goal", required=True, help="what the call should get done")
    p.add_argument("--say", help="the first thing your twin says (optional)")
    args = p.parse_args()

    body = {"to": args.to, "goal": args.goal}
    if args.say:
        body["say"] = args.say

    job = None
    try:
        # Calls start right away and answer 202: the call itself takes minutes.
        job = call("POST", "/calls", body)
        print("Calling %s (job %s)." % (args.to, job["id"]))
        show(job)
        job = wait_for_job(job, show)
    except KeyboardInterrupt:
        # Ctrl-C cancels a call still in line, and asks the Mac to hang up one
        # that's under way (202, cancel_requested). Twinly before 4.1.5 can't
        # stop a running call from the API (409 job_running): end it in Twinly.
        note = "Canceled."
        if job:
            try:
                after = call("POST", "/jobs/%s/cancel" % job["id"])
                if after.get("cancel_requested"):
                    note = "Asked your Twinly to hang up. If someone already answered, the minutes still count."
            except TwinlyError as e:
                if e.code == "job_running":
                    note = "Stopped waiting. The call is already under way: end it in Twinly on your Mac."
                else:
                    note = "Stopped waiting (%s)" % e.message
        print("\n" + note, file=sys.stderr)
        return 130
    except TwinlyError as e:
        print("Error: " + explain(e), file=sys.stderr)
        return 1

    if job["status"] != "done":
        err = job.get("error") or {}
        print("The call %s: %s" % (job["status"], explain(TwinlyError(0, err.get("code"), err.get("message") or "no reason given"))),
              file=sys.stderr)
        return 1

    result = job["result"]
    print("\nTranscript:")
    for turn in result["transcript"]:
        print("  %s: %s" % ("Twin" if turn["who"] == "twin" else "Them", turn["text"]))
    minutes = result["minutes"]
    print("\nOutcome: %s" % result["outcome"])
    print("Length: %d minute%s" % (minutes, "" if minutes == 1 else "s"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
