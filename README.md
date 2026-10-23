# Build with Twinly at a hackathon

Twinly is your AI twin on your Mac. The Twinly API lets your code use it:
text from your own iMessage, read a group chat, make a phone call in your
cloned voice, record a voice note in your voice, hand your Twinly a whole
task, make pictures, and chat with its model. One key, one base URL.

```
https://advktwnedlgnhswpxokg.supabase.co/functions/v1/twinly-api/v1
Authorization: Bearer twk_live_...
```

## What you can build

Each endpoint is one power of the owner's twin. Apps get interesting when you
chain them: read a chat, think about it, answer in the owner's voice, call
someone, or hand the whole job to the Mac as a task. Everything below works
with one key.

| Combine | And you get | Endpoints |
|---|---|---|
| read a chat + chat + send | a digest, a summary or a reply drafted from what people actually said | `GET /v1/messages`, `POST /v1/chat/completions`, `POST /v1/messages` |
| bot command + your code + reply | an `@twinly <command>` bot that works in any iMessage chat, groups included | `bot.command` webhook, your reply (or `POST /v1/messages`) |
| incoming text + chat + send | an assistant that answers in the chats the owner picked | `message.received` webhook, `POST /v1/chat/completions`, `POST /v1/messages` |
| image + send | a picture made from a sentence and texted to someone | `POST /v1/images`, `POST /v1/messages` with an attachment |
| voice + send | a voice note in the owner's cloned voice | `POST /v1/voice/speak`, `POST /v1/messages` with the audio |
| call + text | a phone call to a business with a goal, then the outcome texted back | `POST /v1/calls`, `POST /v1/messages` |
| task + JSON | the Mac researches, browses, reads its calendar, mail or files, and returns fields your code can use | `POST /v1/tasks` with `output_schema` |
| task on a schedule + alert | a watcher: a price, a slot, a page that changes, then a text or a call when it does | your scheduler, `POST /v1/tasks`, `POST /v1/messages` or `POST /v1/calls` |
| screenshot + next action, in a loop | your own computer-use agent for a screen your code controls (a VM, a Playwright browser, a game) | `POST /v1/computer/next-action` |

Project ideas:

- **Group-chat concierge.** `@twinly poll`, `@twinly weather`, `@twinly split 84 4` in a group chat; your webhook answers in the chat. (`bot.command`)
- **Morning digest.** Every morning, read the busiest group chat and text the owner three lines: decisions, questions, plans. (`GET /v1/messages`, chat, `POST /v1/messages`)
- **The booking caller.** Give it a restaurant's number and a goal ("a table for 4 at 7, somewhere quiet if they can"): the twin calls, you get the transcript, and the owner gets a text with the result. (`POST /v1/calls`, `POST /v1/messages`)
- **Slot sniper.** Check a booking page every 10 minutes with a task that returns `{"open": true, "times": [...]}`, then text or call the owner the moment a slot opens. (`POST /v1/tasks` + `output_schema`)
- **Price watch.** A task reads a product page and returns the price as JSON; text the owner when it drops. (`POST /v1/tasks`)
- **Voice postcards.** Draw a picture from a sentence, add a voice note in the owner's voice, text both to a friend. (`POST /v1/images`, `POST /v1/voice/speak`, `POST /v1/messages`)
- **Follow-up nudger.** Find questions people asked the owner that got no answer this week and list them, with drafts. (`GET /v1/messages`, chat)
- **RSVP counter.** Text a group a question, read the replies the next day, and tally who's in. (`POST /v1/messages`, `GET /v1/messages`, chat)
- **Meeting prep.** A task reads tomorrow's calendar and the related email threads and returns a one-page brief as JSON for your UI. (`POST /v1/tasks`)
- **Read it to me.** Turn any article into a short audio summary in the owner's voice. (`POST /v1/tasks` or chat, `POST /v1/voice/speak`)
- **Text adventure or trivia in a group chat.** Your server keeps the game state; `@twinly` commands play it. (`bot.command`)
- **Your own computer-use agent.** Screenshot a VM or a headless browser, ask for the next action, perform it, repeat; benchmark it against a task list. (`POST /v1/computer/next-action`)
- **Wake-up call.** At 7, the twin calls the owner and reads the day's calendar and the weather in their own voice. (`POST /v1/tasks`, `POST /v1/calls`)
- **Bill splitter.** `@twinly split 84.50 4 tip 20` in a group chat: your webhook does the math and posts each share back. (`bot.command`)

Notes for coding agents:

- Call `GET /v1/me` first: it says whether the owner's Mac is online, what this key may call, and (Twinly 4.1.5+) what each family of endpoints still needs set up in `mac.setup`.
- Mac endpoints are jobs that run on the owner's Mac under their approval settings. A held step shows `needs_approval` until they decide. A Mac runs up to two jobs at once, and one call or task at a time.
- A task only texts, emails or calls someone when its prompt asks for that, and only the person it names. To send something yourself, use `POST /v1/messages`.
- Calls dial US numbers through the owner's Google Voice and need the Mac's call setup.
- `POST /v1/computer/next-action` is for screens your code controls; it returns one action and never touches the owner's Mac.
- Twinly never solves robot checks or types card numbers or Social Security numbers. Plan around both.
- Test without a key or a Mac against the mock API in the starter projects; it answers like production.

## 1. Get a key (5 minutes)

1. **Download Twinly** from [twinly.tech](https://twinly.tech), move it to
   Applications and open it.
2. **Sign in with Google** when it asks.
3. **Accept the Terms** when Twinly shows them. Until you do, your Mac doesn't
   check in, and every Mac endpoint answers `409 twinly_offline`.
4. **Settings ▸ Developer API ▸ Create a key.** Name it after your project.
   The key is shown once: put it in your project's `.env` right away.
5. Each key has scopes (texting, reading chats, calls, voice, tasks, images,
   chat, bots). New keys get all of them; untick what your project doesn't need.
6. In the same section, the **Jobs on this Mac** card has the switch **Let
   keys text, call and run tasks as you**. It's on by default; keep it on.
   Without it, Mac endpoints answer `409 twinly_offline` and no webhook or bot
   event is sent.
7. Keep Twinly running. Texts, chat reads, calls, voice notes and tasks run on
   your own Mac, under your own approval settings, and come back as a job. If
   Twinly isn't open you get `409 twinly_offline` right away.
8. Check it all works, before writing a line of code (free, no scope needed):

   ```bash
   curl -s https://advktwnedlgnhswpxokg.supabase.co/functions/v1/twinly-api/v1/me \
     -H "Authorization: Bearer $TWINLY_API_KEY"
   ```

   `mac.online: true` means your Mac is taking jobs; `can` lists every
   endpoint your key may call right now. Run it again before your demo. Each
   Mac endpoint also needs its own setup once:
   [set up your Mac](#set-up-your-mac-once-10-minutes).

Import [`openapi.yaml`](https://www.twinly.tech/openapi.yaml)
into Postman or Insomnia to try every endpoint without writing code.

Tip: `POST /v1/tasks` takes an `output_schema` (a JSON Schema) and returns the
answer as `data` in that shape, so your app gets fields instead of a paragraph.

## 2. Redeem your $20 voucher

**Settings ▸ Developer API ▸ Redeem a code** (also on the **Account** screen).
Type **`TWINLYHACK`**; $20 of usage (200 credits) lands on your account. Each
account can redeem it once. It works for the first 500 accounts, through
December 31, 2026.

On the free plan you get 5 free prompts a day (each request or job uses one;
they come back at midnight UTC). After those, your voucher's $20 keeps
everything working until it's spent.

## 3. What it costs

Every call is charged to the key owner's Twinly account (1 credit = $0.10):

| what | credits | dollars |
|---|---|---|
| send a text (`POST /v1/messages`) | 0.5 | $0.05 |
| read a chat (`GET /v1/messages`) | 0.2 | $0.02 |
| a voice note (`POST /v1/voice/speak`) | 1.0 | $0.10 |
| a picture (`POST /v1/images`) | 0.5 | $0.05 |
| a task (`POST /v1/tasks`) | 2.0 plus model usage | $0.20 + |
| a phone call (`POST /v1/calls`) | 3.0 per started minute | $0.30 a minute |

A $20 voucher covers about 400 texts, or 200 voice notes, or 65 call
minutes, and each teammate's own plan covers the rest. When an account can't
cover a job you get `402 insufficient_usage` before anything runs.

## 4. Pick a starter

Each folder is a complete project with a README you can follow in 10
minutes, a `.env.example`, and a test that runs against a local mock.

| starter | language | it does | uses |
|---|---|---|---|
| [imessage-bot](imessage-bot/) | Node | `@twinly weather Gainesville` in any chat gets an answer | `bot.command` webhook, signature check |
| [call-agent](call-agent/) | Python | places a call in your voice with a goal, prints the transcript | `calls`, jobs |
| [voice-postcard](voice-postcard/) | Python | says your message in your voice and texts the audio | `voice/speak`, `messages` |
| [web-task-cli](web-task-cli/) | Node | gives your Twinly a task, prints the answer, saves the files | `tasks`, jobs |
| [meme-texter](meme-texter/) | Python | makes a picture and texts it | `images`, `messages` |
| [group-digest](group-digest/) | Node | reads a group chat and writes a 3 to 5 bullet catch-up | `messages` read, `chat/completions` |

Node 20+ or Python 3.9+, and nothing to install: the Node ones use only
built-ins, the Python ones only the standard library.

## 5. Build before you have a key

[`mock-api/`](mock-api/) is a local stand-in for the whole API, including a
fake Mac that runs jobs and signed webhooks. Nothing leaves your computer.

```bash
node mock-api/server.js
# key: twk_live_MockKeyForTwinlyExamplesNotARealKey00000000
# base: http://127.0.0.1:4010/v1
./run-all-tests.sh        # every starter's test against the mock
```

## Set up your Mac once (10 minutes)

The Mac endpoints use your own Mac, so each needs its piece of Twinly set up
first. Do these before the hackathon starts, not during your demo:

| to use | set up in Twinly | then check |
|---|---|---|
| anything on the Mac | stay signed in with the Terms accepted, keep Twinly open, keep **Let keys text, call and run tasks as you** on, and keep the Mac awake (System Settings ▸ Lock Screen, or run `caffeinate -d` in a terminal) | `GET /v1/me` says `"online": true` |
| texts (`/v1/messages`) | Messages signed in to iMessage on this Mac; Full Disk Access (to find chats) and Automation for Messages (to send). The **Access** screen's **Set everything up** button grants both | text yourself from the app once |
| reading chats (`GET /v1/messages`) | Messages signed in; Full Disk Access | `node group-digest/digest.js --with <your number>` |
| voice (`/v1/voice/speak`) | the **Voice** screen: record your clips, then **Build my clone** (needs an Apple silicon Mac) | `voice_not_set_up` means this step is missing |
| calls (`/v1/calls`) | a **Google Voice** account (US numbers only) signed in inside **Google Chrome**, with calling on; **BlackHole 2ch** installed (the Voice screen's **Before your twin can call** card installs it); **Screen Recording** for Twinly; a recorded voice (above); Chrome's **View ▸ Developer ▸ Allow JavaScript from Apple Events** on | one test call from the app; a missing piece fails the job with `call_failed` and names it |
| tasks on the screen (`/v1/tasks`) | Screen Recording and Accessibility (**Set everything up** on the Access screen) | ask Twinly in the app to "open Calculator" |
| bots (`@twinly <command>`) | **Settings ▸ Messages ▸ @twinly in Messages** on (it's off on a fresh install), Full Disk Access, a webhook URL and your commands in Settings ▸ Developer API | type `@twinly <command>` yourself in Messages; texts sent through the API never trigger it |

The **Access** screen (in Twinly's sidebar) has a **Set everything up**
button that runs every grant and install in order. macOS only applies Screen
Recording and Full Disk Access after Twinly restarts; the Access screen offers
the restart. A permission Twinly still hasn't been given shows up as a card the
first time a job needs it (in the notch on Twinly 4.1.3 and later, in
Approvals in the main window on 4.1.2); allow it there and the job carries on.

## How Mac jobs work

`POST /v1/messages`, `GET /v1/messages`, `/v1/calls`, `/v1/voice/speak` and
`/v1/tasks` create a job your Mac picks up. Add `?wait=<0-25>` to wait for it:
`200` means it finished in time, `202` means it's still going (texts and
voice wait 25 seconds by default, calls and tasks return at once). Then call
`GET /v1/jobs/{id}?wait=25` in a loop: the server answers as soon as the
status changes (`202` while it's still going, `200` once it's `done`,
`failed`, `canceled` or `expired`). `needs_approval` means your Twinly is
asking you first, in the app. `POST /v1/jobs/{id}/cancel` cancels a job that
hasn't started yet; once it's running, you stop it in Twinly. Every starter
has a tiny client (`twinly.js` or `twinly.py`) that does this for you. It
retries a `429` or a passing `503`, but never resends a job after
`503 job_unverified`: that job may still run, so check Twinly's task list (or
Messages) before you send it again.

Attach up to 4 files to a text, each an `https://` link or inline as
`{"name": "photo.jpg", "mime": "image/jpeg", "b64": "..."}`. One file of
about 25 MB fits inline; send bigger sets as links.

## Play fair

- Keep keys on a server or your laptop, never in a web page or a public repo.
  `.env` is git-ignored here; only `.env.example` is committed.
- Text and call people who'd want to hear from you. For demos, use your own
  number. Anything your Twinly sends goes out as you.
- A webhook can make your Twinly text people, so always check its signature
  (see `imessage-bot/signature.js`).

Full reference: [twinly.tech/docs/developer-api](https://www.twinly.tech/docs/developer-api)
(every endpoint, jobs, scopes, webhooks, bots, errors), and the OpenAPI spec at
[twinly.tech/openapi.yaml](https://www.twinly.tech/openapi.yaml). `smoke-live.sh` runs all six against the real API,
sending only to you.
