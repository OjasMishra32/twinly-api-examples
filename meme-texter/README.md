# meme-texter

Describe a picture, get it made, and text it to a friend or the group chat,
all from one command.

```
$ python3 meme.py --chat "Hack Squad" "our team as superheroes" --caption "us tomorrow"
Made the picture: ./meme-3fa91c02.jpg
Texted it to chat493021 (delivered).
```

Uses `POST /v1/images` (made in the cloud) and `POST /v1/messages` with the
picture as an attachment (sent by your Mac, from your number). Python 3.9 or
newer, standard library only.

## Setup (5 minutes)

1. **Settings ▸ Developer API ▸ Create a key**, with the `images` and
   `messages.send` scopes.
2. Keep Twinly running on your Mac (it does the texting).
3. `cp .env.example .env` and paste your key in.

The picture goes out attached right in the request, as
`{"name": "meme.jpg", "mime": "image/jpeg", "b64": "..."}`. (An attachment
can also be an `https://` link your Mac downloads, for a picture that's
already online.)

## Run

```bash
python3 meme.py "a cat DJ at a frat party" --save-only     # just make and save it
python3 meme.py --to "Sam Lee" "a gator in a hoodie writing code at 3am"
python3 meme.py --chat "Hack Squad" "us as superheroes" --caption "us tomorrow" --shape wide
```

`--shape` is `square` (default), `wide` or `tall`. The caption defaults to
your prompt. `--save-only` doesn't need your Mac at all.

## Try it with no account

```bash
node ../mock-api/server.js
TWINLY_API_BASE=http://127.0.0.1:4010/v1 \
TWINLY_API_KEY=twk_live_MockKeyForTwinlyExamplesNotARealKey00000000 \
python3 meme.py --to Mom "a gator in a hoodie"
```

The mock's picture is always the same small green JPEG (one per shape).

## Test

```bash
python3 -m unittest discover -s test -v
```

Checks that the exact image bytes are the bytes that got attached, plus
shapes and captions, `--save-only` with the Mac off, a missing recipient
(caught before anything is spent), an empty balance and a key without the
`images` scope.

## Make it yours

- Pick the prompt with `POST /v1/chat/completions` first ("write a meme idea
  about this group chat"), then make the picture.
- Pair it with `../imessage-bot`: an `@twinly meme <idea>` command that
  answers with `{"reply": "...", "attachments": [{"name", "mime", "b64"}]}`.
- Cost: 0.5 credits ($0.05) for the picture and 0.5 ($0.05) for the text.
