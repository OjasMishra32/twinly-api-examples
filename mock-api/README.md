# Twinly mock API

A local stand-in for the Twinly API v2. Same paths, same auth, same job
objects, same errors, same signed webhooks. A built-in "fake Mac" picks up
jobs and finishes them with fixed results, so you can build your whole project
before you have a key, and your tests never need an account.

It never calls the internet and never touches iMessage, a phone or a real
model. Every "sent" text, call and voice note lands in a log you can read.

## Run it

Needs Node 20 or newer. No `npm install`.

```bash
node server.js
```

```
Twinly mock API on http://127.0.0.1:4010/v1
  key:            twk_live_MockKeyForTwinlyExamplesNotARealKey00000000
  webhook secret: whsec_mock_...
```

Point any example at it:

```bash
TWINLY_API_BASE=http://127.0.0.1:4010/v1
TWINLY_API_KEY=twk_live_MockKeyForTwinlyExamplesNotARealKey00000000
```

`node server.js --help` lists every switch. The useful ones:

| switch | what you get |
|---|---|
| `--offline` | your Mac is "off": Mac endpoints answer `409 twinly_offline` |
| `--paused` | the Mac's heartbeat looks fine but it never picks jobs up (they wait, then expire as `queue_timeout`) |
| `--balance 0` | the account is out of usage: `402 insufficient_usage` |
| `--hold messages.send` | your approval mode holds that kind: the job sits in `needs_approval` |
| `--webhook-url <url>` | where the fake Mac POSTs signed events |
| `--bot-commands weather` | registers a bot command, for `@twinly weather ...` |
| `--allow-local-attachments` | accepts `http://127.0.0.1/...` attachment URLs and actually downloads them (inline `{name, mime, b64}` attachments need nothing) |
| `--fast` | short job times and webhook retries (what the tests use) |

## What the fake Mac knows

- You are **Alex Rivera**, `+15555550100`.
- Contacts: `Mom` (+15555550101), `Sam Lee`, `Priya Shah`, `Diego Ortiz`,
  `Bella's Bistro` (+15555550199). Any phone number or email works too; an
  unknown name fails the job with `recipient_not_found`.
- Chats: `Hack Squad` (id `chat493021`, a group with 8 messages), your chat
  with Mom (`chat100001`) and your own note-to-self chat (`chat100000`).
- Results are fixed: every call has the same polite 6-line transcript built
  from your goal, every voice note is the same 1.2 second chime (a real
  `audio/mp4` file), every image is a small green JPEG, and a task whose prompt
  mentions a screenshot, image or file comes back with a small PNG.

## Controls

Plain JSON over HTTP, no key needed (it only listens on 127.0.0.1):

| | |
|---|---|
| `GET /_mock/state` | jobs, the outbox (every message "sent", with each attachment's size and SHA-256), calls, chat requests, webhook deliveries with each attempt, charges, balance |
| `POST /_mock/config` | change any setting, for example `{"mac": "offline"}`, `{"balance_credits": 0}`, `{"hold": ["calls.place"]}`, `{"webhook_url": "http://127.0.0.1:8787/twinly/webhook"}`, `{"chat_reply": "fixed text"}`, `{"queue_timeout_ms": 1000}` |
| `POST /_mock/reset` | back to a fresh start |
| `POST /_mock/jobs/<id>/decide` | `{"approve": true}` or `false`, for a `needs_approval` job |
| `POST /_mock/jobs/<id>/stop` | the owner pressing Stop in Twinly: a running or held job becomes `canceled` |
| `POST /_mock/bot-command` | `{"text": "@twinly weather Gainesville", "chat": "chat493021", "from_me": false}`: sends a signed `bot.command` to your webhook, waits up to 10 s, posts your reply into the chat, and tells you what happened |
| `POST /_mock/message-received` | `{"chat": "Hack Squad", "text": "..."}`: emits `message.received` if that chat is in `message_received_chats` |
| `POST /_mock/webhooks/test` | sends a `webhook.test` event (the app's "Send test event") |
| `POST /_mock/keys` | `{"scopes": ["chat"]}` makes another key, to try `scope_missing` |

In code, `testkit.js` (Node) and `testkit.py` (Python) start the mock on a
free port and wrap these controls. Every example's test uses them.

## How it reads the contract

The mock follows `docs/developer-api/SPEC-v2.md` and matches the finished
server (branch `api-v2/server`) on status codes, error codes and limits. Where
the contract leaves a choice open, this is the choice the mock makes (and the
examples rely on nothing beyond it):

- **Errors** use v1's shape: `{"error": {"message", "type", "code", "param"}}`,
  with `type` from the status (`authentication_error`, `insufficient_quota`,
  `permission_error`, ...). Examples only read `code`.
- **Check order** for a Mac endpoint: origin, route, key, requests per minute,
  scope, body, `?wait`, then `409 twinly_offline`, then
  `402 insufficient_usage`, then the job is created.
- **`?wait`** is 0 to 25 seconds, decimals allowed; anything else is
  `400 invalid_parameter` (param `wait`). 200 means the job reached `done`,
  `failed`, `canceled` or `expired` in time; otherwise 202, and that includes a
  job sitting in `needs_approval`.
- **`GET /v1/jobs/{id}?wait=0..25`** (default 0) holds the answer until the
  job finishes or its status changes from what it was when the request
  arrived, so a client that loops on `wait=25` makes one request per change.
  Like the create endpoints it answers 200 once the job is finished and 202
  while it isn't. A key sees only jobs it created; any other id is
  `404 job_not_found`. Jobs and cancel need no scope.
- **Cancel** only works on a job still `queued` (it becomes `canceled`, and
  canceling it again is a 200). A job already on the Mac (`running` or
  `needs_approval`) is `409 job_running`: the owner stops it in Twinly. A
  finished one is `409 job_finished`.
- **`result` and `error`** are always present, `null` when empty.
- **Validation errors** are 400 with `param` naming the field:
  `invalid_recipient` (not exactly one of `to`/`chat`, or `chat`/`with`),
  `invalid_attachments`, `attachment_too_large`, `invalid_prompt` (images),
  and `invalid_parameter` for the rest. Limits: `to` 128 characters, `chat`
  256, message `text` 4000 (it may be empty when there's an attachment),
  `goal` 2000, `say` 1000, spoken `text` 600, task `prompt` 4000.
- **Job errors the spec doesn't name** (made up here, so the Mac piece can
  pick its own): `recipient_not_found`, `chat_not_found`, `declined` (the
  owner said no to a held step), `attachment_unavailable`,
  `attachment_too_large`.
- **Expiry:** a queued job expires as `twinly_offline` when it's over 120 s
  old and the Mac's heartbeat is stale. While the Mac is up, a job may wait
  in line (behind a call, say) for up to 30 minutes, then expires as
  `queue_timeout`.
- **`messages.read`** returns the newest `limit` messages, oldest first.
  `chat` takes a chat id or a group's name; `with` takes a handle or a
  contact name.
- **Credits** (1 credit = $0.10): `messages.send` 0.5, `messages.read` 0.2,
  `voice.speak` 1.0, `images` 0.5, `tasks.run` 2.0 plus model usage (the mock
  adds 0.5), `calls.place` 3.0 per started minute, minimum 1. A job reserves
  its minimum at creation (so `402` happens before anything runs) and is
  charged only if it finishes `done`; a failed, canceled or expired job costs
  nothing. `GET /v1/usage` shows this key's spend as `usage_usd` and the
  account's balance as `plan.extra_usage_usd`.
- **Concurrency:** at most 2 jobs run at once and a call never runs beside a
  task.
- **Webhooks:** every body is an envelope
  `{"id": "evt_...", "type": "...", "created_at": "...", "data": {...}}`.
  `job.finished` carries the job object (sent for `done`, `failed`, and for
  `canceled` once the Mac had claimed it; never for `expired`). `call.ended`
  carries `{job_id, to, minutes, transcript, outcome}`. `bot.command` carries
  `{command, args, chat, from, from_me, text}` where `args` is the rest of the
  message as one string and `from` is always a handle (your own when
  `from_me`). `message.received` carries `{chat, from, name, text, at}`.
- **Signatures:** `X-Twinly-Signature: t=<unix>,v1=<hex>`, the HMAC-SHA256 of
  `"<t>.<raw body>"` keyed with the secret's text exactly as shown (prefix
  included). The examples reject a timestamp more than 5 minutes off.
- **Retries:** a non-2xx gets 3 more tries after 1, 4 and 15 s. `bot.command`
  is the exception: one try, a 10 s wait for the reply, no retries (a slow
  bot that answered late would otherwise reply twice).
- **Bots** need a registered command, a webhook URL and at least one live key
  with the `bots` scope. Guests are limited to 6 commands a minute each.
- **Attachments** (texts and bot replies) are up to 4 of: an `https://` URL
  on a public host name that the Mac downloads, or an inline
  `{"name", "mime", "b64"}` file (a plain file name with no folders, standard
  padded base64 with no `data:` prefix, at most 25 MB decoded). Either way
  the outbox records each file's size and SHA-256, so tests can check the
  exact bytes. With `--allow-local-attachments` the mock also accepts and
  fetches `http://127.0.0.1` URLs.
- **Request size:** `POST /v1/messages` takes up to 34 MiB, so one file of
  about 25 MB fits inline (send bigger sets as URLs); every other route keeps
  v1's 6 MB. Over it is `413 request_too_large`.
