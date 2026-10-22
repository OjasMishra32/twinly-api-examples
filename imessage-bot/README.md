# imessage-bot

An `@twinly` bot for any iMessage chat. Someone texts
`@twinly weather Gainesville` and your Twinly answers right there in the chat:

```
Priya:  @twinly weather Gainesville
You:    Gainesville: 83°F and light rain (sample data)
```

How it works: your Twinly on your Mac spots the message, POSTs a signed
`bot.command` webhook to this little server, waits up to 10 seconds, and sends
your `{"reply": "..."}` back into the chat as you. Node 20 or newer, no
packages, one small file per job (the server, the signature check, the weather).

## Setup (10 minutes)

1. **Key with the bots scope.** In the Twinly Mac app: **Settings ▸ Developer
   API ▸ Create a key**, and leave `bots` ticked. The bot itself never sends
   the key anywhere; Twinly only delivers bot commands while one of your keys
   allows `bots`. In the same section, keep **Let keys text, call and run
   tasks as you** on (the **Jobs on this Mac** card); with it off, Twinly
   sends no events at all.
2. **Turn on @twinly.** Bot commands ride on Twinly's @twinly watcher, so they
   only fire while **@twinly in Messages** is on, in **Settings ▸ Messages**
   (it's off on a fresh install), and Twinly has **Full Disk Access** (System
   Settings ▸ Privacy & Security ▸ Full Disk Access; restart Twinly after you
   grant it). Messages has to be signed in on this Mac. If something is
   missing, the @twinly switch shows a warning line saying what.
3. **Start the bot.**

   ```bash
   cp .env.example .env
   node bot.js
   # Bot listening on http://127.0.0.1:8787/twinly/webhook
   ```

4. **Point Twinly at it.** Your own Mac sends the webhook, so a bot running
   on the same Mac needs no tunnel. In **Settings ▸ Developer API**:
   - **Webhook** card: URL `http://127.0.0.1:8787/twinly/webhook` (plain http
     is allowed for this Mac only), then **Save**.
   - **Show secret**, paste it into `.env` as `TWINLY_WEBHOOK_SECRET`, and
     restart `node bot.js`.
   - **Bot commands** card: add `weather`.
   - **Send test event**: the bot prints the event it got. (The test goes out
     even when the switch in step 1 is off, so it proves the URL and secret,
     not the rest.)
5. **Try it.** In any chat, type `@twinly weather Gainesville` yourself, in
   Messages on the Mac or your phone. A text your code sends through
   `POST /v1/messages` never triggers @twinly.

**The bot never answers?** Check, in order: @twinly in Messages is on and
shows no warning; Twinly has Full Disk Access; **Let keys text, call and run
tasks as you** is on; a live key still has `bots`; the webhook URL is saved
and **Send test event** reaches the bot; the bot answers within 10 seconds.

**Bot running somewhere else** (a server, a teammate's laptop)? Give it a
public https address and use that as the webhook URL. A free quick tunnel
works, no account needed:

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:8787
# ... https://some-words.trycloudflare.com  →  .../twinly/webhook
```

For real weather, set `WEATHER_SOURCE=open-meteo` in `.env` (Open-Meteo's free
API, no key). The default makes up a forecast from the city's name, so the bot
works offline and on stage.

## What you'll see

The terminal running the bot logs each command and its answer:

```
@twinly weather Gainesville   (from +15555550103 in chat493021)
  -> Gainesville: 83°F and light rain (sample data)
```

and the reply shows up in the chat a second later.

## Security

Every webhook carries `X-Twinly-Signature: t=<unix>,v1=<hex>`, an HMAC-SHA256
of `"<t>.<raw body>"` keyed with your signing secret. `signature.js` checks it
over the raw bytes, in constant time, and refuses anything more than 5 minutes
old. Without that check, anyone who finds your tunnel URL could make your
Twinly text your friends. Keep the secret in `.env`, never in git.

Guests (anyone in the chat who isn't you) are rate-limited by Twinly, and only
the commands you registered ever reach the bot.

## Try it with no account

```bash
# terminal 1
TWINLY_WEBHOOK_SECRET=whsec_local_test node bot.js
# terminal 2
node ../mock-api/server.js --webhook-url http://127.0.0.1:8787/twinly/webhook \
  --webhook-secret whsec_local_test --bot-commands weather
# terminal 3: pretend Priya texted the group
curl -s 127.0.0.1:4010/_mock/bot-command -H 'content-type: application/json' \
  -d '{"chat":"Hack Squad","from":"+15555550103","text":"@twinly weather Gainesville"}'
```

The mock signs the webhook exactly like your Mac does, posts the bot's reply
into its fake chat, and shows it in `GET /_mock/state` under `outbox`.

## Test

```bash
npm test
```

Starts the mock and the bot, plays a guest and you texting the command, and
checks the reply lands in the right chat. Also checks that forged, missing,
stale and tampered signatures get a 401, and that a retried event runs once.

## Make it yours

Add a command in `bot.js`:

```js
const COMMANDS = {
  async weather(args) { ... },
  async flip() {
    return { reply: Math.random() < 0.5 ? "Heads" : "Tails" };
  },
};
```

then add `flip` under **Bot commands** in Twinly. A reply can carry up to 4
files too, each an `https://` link or the file itself:
`{"reply": "Here you go", "attachments": [{"name": "cat.jpg", "mime": "image/jpeg", "b64": "..."}]}`.
Answer within about 8 seconds; Twinly stops waiting at 10.
