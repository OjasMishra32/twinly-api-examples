# voice-postcard

Type a message; your Twinly says it in **your own cloned voice** and texts it
as an audio message. Birthday wishes, a "we won!" to the group, a goodnight
from the other side of the country.

```
$ python3 postcard.py --to Mom --say "Happy birthday! Wish I could be there."
Recorded 2.9 seconds in your voice: ./postcard-e13bec.m4a
Sent to +13525550101 (delivered).
```

Uses `POST /v1/voice/speak` (your Mac renders the clip) and `POST /v1/messages`
with the clip as an attachment. Python 3.9 or newer, standard library only.

## Setup (5 minutes)

1. Clone your voice in the Twinly app first, if you haven't: the **Voice**
   screen, record your clips, then **Build my clone** (an Apple silicon Mac).
   Without it the job fails with `voice_not_set_up`. Texts also need Messages
   signed in, plus Full Disk Access and Automation for Messages (the
   **Access** screen's **Set everything up** grants both).
2. **Settings ▸ Developer API ▸ Create a key**, with the `voice` and
   `messages.send` scopes.
3. Keep Twinly running on your Mac.
4. `cp .env.example .env` and paste your key in.

The clip goes out attached right in the request, as
`{"name": "postcard.m4a", "mime": "audio/mp4", "b64": "..."}`. (An attachment
can also be an `https://` link your Mac downloads, if the file already lives
online.)

## Run

```bash
python3 postcard.py --say "Testing my voice" --save-only                # just save the .m4a
python3 postcard.py --to Mom --say "Happy birthday! Wish I could be there."
python3 postcard.py --chat "Hack Squad" --say "We won!" --caption "Listen to this"
```

`--to` is a phone number, email or contact name; `--chat` is a group's name
or id. `--say` can be up to 600 characters. For a demo, send it to yourself.

## Try it with no account

```bash
node ../mock-api/server.js
TWINLY_API_BASE=http://127.0.0.1:4010/v1 \
TWINLY_API_KEY=twk_live_MockKeyForTwinlyExamplesNotARealKey00000000 \
python3 postcard.py --to Mom --say "Happy birthday"
```

The mock's "voice" is always the same 1.2 second chime (a real .m4a you can
play). `curl 127.0.0.1:4010/_mock/state` shows the size and checksum of the
file it "texted".

## Test

```bash
python3 -m unittest discover -s test -v
```

Checks that the exact audio bytes the voice endpoint returned are the bytes
that got attached, plus sending to a group, `--save-only`, a missing
recipient (caught before anything is spent), a too-long message and an
offline Mac.

## Make it yours

- Make it a daily voice note: a cron job that speaks today's weather or
  calendar.
- Use the clip anywhere: `voice["audio_b64"]` is a normal `audio/mp4` file.
- Cost: 1 credit ($0.10) for the voice note and 0.5 ($0.05) for the text.
