# group-digest

Missed 200 messages in the group chat? This reads the chat through your own
Twinly (iMessage on your Mac) and asks Twinly's model for a 3 to 5 bullet
catch-up. Add `--post` to drop the digest into the chat for everyone.

```
$ node digest.js --chat "Hack Squad"
Digest of Hack Squad (last 30 messages):

- Demo is at 4pm, and the judges want a 3 minute pitch
- Sam is getting pizza (two large, one veggie)
- You said the backend is deployed; the architecture slide is cut
```

Uses `GET /v1/messages` (a job your Mac runs) and `POST /v1/chat/completions`
(answered in the cloud). Node 20 or newer, no packages.

## Setup (5 minutes)

1. In the Twinly Mac app: **Settings ▸ Developer API ▸ Create a key**. It
   needs the `messages.read` and `chat` scopes, plus `messages.send` if you
   use `--post`.
2. Keep Twinly running on your Mac, with Full Disk Access granted (that's how
   Twinly reads Messages).
3. `cp .env.example .env` and paste your key in.

## Run

```bash
node digest.js --chat "Hack Squad"            # a group by its name
node digest.js --with Mom                     # your 1:1 chat with someone
node digest.js --chat "Hack Squad" --limit 50 # up to 50 messages
node digest.js --chat "Hack Squad" --post     # and post the digest into the chat
```

`--chat` takes a group's name or a chat id; `--with` takes a contact's name,
a phone number or an email. Reading is private: nothing is
sent anywhere unless you add `--post`, which sends one message as you.

## Try it with no account

```bash
node ../mock-api/server.js
TWINLY_API_BASE=http://127.0.0.1:4010/v1 \
TWINLY_API_KEY=twk_live_MockKeyForTwinlyExamplesNotARealKey00000000 \
node digest.js --chat "Hack Squad"
```

The mock has a "Hack Squad" group with 8 messages. Its model doesn't really
summarize: it answers with a stock line (tests set a fixed reply).

## Test

```bash
npm test
```

Checks that every message reaches the model with names instead of numbers,
that `--limit` and `--post` do what they say, and that a missing scope, an
unknown chat and an offline Mac each print one clear line.

## Make it yours

- Change the system prompt in `digest.js` to get action items only, a
  "who owes who" list, or a summary in another language.
- Run it every evening with `cron`, or point it at a chat with yourself and
  `--post` to keep a running log.
- Cost: reading a chat is 0.2 credits ($0.02), the summary is a small chat
  call, and `--post` is 0.5 credits ($0.05).
