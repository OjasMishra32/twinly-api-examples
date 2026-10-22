#!/usr/bin/env python3
"""Send a voice postcard: your Twinly says something in YOUR cloned voice,
then texts it as an audio message.

    python3 postcard.py --to Mom --say "Happy birthday! Wish I could be there."
    python3 postcard.py --chat "Hack Squad" --say "We won!" --caption "Listen to this"
    python3 postcard.py --say "Testing my voice" --save-only      (just save the .m4a)
"""

import argparse
import base64
import os
import sys

from twinly import TwinlyError, call, explain, finished, load_env


def main():
    load_env()
    p = argparse.ArgumentParser(description="Speak a message in your cloned voice and text it.")
    who = p.add_mutually_exclusive_group()
    who.add_argument("--to", help="a phone number, email or contact name")
    who.add_argument("--chat", help="a group chat's name or id")
    p.add_argument("--say", required=True, help="what your voice says (up to 600 characters)")
    p.add_argument("--caption", default="I made you a voice postcard.", help="the text that goes with it")
    p.add_argument("--out", default=".", help="folder to save the .m4a in")
    p.add_argument("--save-only", action="store_true", help="save the voice note, don't send it")
    args = p.parse_args()
    if not args.save_only and not (args.to or args.chat):
        p.error("say who gets it: --to or --chat (or use --save-only)")

    try:
        # 1. Your voice says it (on your Mac, in your clone).
        voice = finished(call("POST", "/voice/speak", {"text": args.say}))
        audio = base64.b64decode(voice["audio_b64"])
        os.makedirs(args.out, exist_ok=True)
        saved = os.path.join(args.out, "postcard-%s.m4a" % base64.b16encode(os.urandom(3)).decode().lower())
        with open(saved, "wb") as f:
            f.write(audio)
        print("Recorded %.1f seconds in your voice: %s" % (voice["seconds"], saved))
        if args.save_only:
            return 0

        # 2. Text it, with the clip attached right in the request.
        clip = {"name": "postcard.m4a", "mime": voice["mime"], "b64": voice["audio_b64"]}
        target = {"to": args.to} if args.to else {"chat": args.chat}
        sent = finished(call("POST", "/messages", dict(target, text=args.caption, attachments=[clip])))
        print("Sent to %s%s." % (sent["to"], " (delivered)" if sent.get("delivered") else ""))
        return 0
    except TwinlyError as e:
        print("Error: " + explain(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
