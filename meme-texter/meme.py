#!/usr/bin/env python3
"""Dream up a picture and text it to a friend.

    python3 meme.py --to Mom "a gator in a hoodie writing code at 3am"
    python3 meme.py --chat "Hack Squad" "our team as superheroes" --caption "us tomorrow" --shape wide
    python3 meme.py "a cat DJ" --save-only                       (just save the .jpg)
"""

import argparse
import base64
import hashlib
import os
import sys

from twinly import TwinlyError, call, explain, finished, load_env


def main():
    load_env()
    p = argparse.ArgumentParser(description="Make a picture with Twinly and text it.")
    p.add_argument("prompt", help="what the picture shows")
    who = p.add_mutually_exclusive_group()
    who.add_argument("--to", help="a phone number, email or contact name")
    who.add_argument("--chat", help="a group chat's name or id")
    p.add_argument("--caption", help="the text that goes with it (default: the prompt)")
    p.add_argument("--shape", choices=["square", "wide", "tall"], default="square")
    p.add_argument("--out", default=".", help="folder to save the .jpg in")
    p.add_argument("--save-only", action="store_true", help="save the picture, don't send it")
    args = p.parse_args()
    if not args.save_only and not (args.to or args.chat):
        p.error("say who gets it: --to or --chat (or use --save-only)")

    try:
        # 1. Make the picture (answered in the cloud; your Mac isn't needed for this step).
        image = call("POST", "/images", {"prompt": args.prompt, "shape": args.shape})["data"][0]
        picture = base64.b64decode(image["b64_json"])
        os.makedirs(args.out, exist_ok=True)
        saved = os.path.join(args.out, "meme-%s.jpg" % hashlib.sha256(picture).hexdigest()[:8])
        with open(saved, "wb") as f:
            f.write(picture)
        print("Made the picture: %s" % saved)
        if args.save_only:
            return 0

        # 2. Text it, with the picture attached right in the request.
        attachment = {"name": "meme.jpg", "mime": image["mime"], "b64": image["b64_json"]}
        target = {"to": args.to} if args.to else {"chat": args.chat}
        sent = finished(call("POST", "/messages", dict(target, text=args.caption or args.prompt, attachments=[attachment])))
        print("Texted it to %s%s." % (sent["to"], " (delivered)" if sent.get("delivered") else ""))
        return 0
    except TwinlyError as e:
        print("Error: " + explain(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
