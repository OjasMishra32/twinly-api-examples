# call-agent

Your Twinly makes a real phone call for you, in your cloned voice, with a goal
("book a table for 2 at 7pm"). This script places the call, waits while it
happens, and prints the whole conversation and how it went.

```
$ python3 call_agent.py --to "Bella's Bistro" --goal "Book a table for 2 at 7pm"
Calling Bella's Bistro (job 9f1e...).
On the call now...

Transcript:
  Them: Hi, thanks for calling. How can I help you?
  Twin: Hi! I'm calling to book a table for 2 at 7pm.
  Them: Sure, I can help with that. What name should I put down?
  ...

Outcome: Table for 2 booked at 7pm under Alex.
Length: 2 minutes
```

Uses `POST /v1/calls` and `GET /v1/jobs/{id}`. Python 3.9 or newer, standard
library only (no `pip install`).

## Setup (5 minutes)

1. Calling has to work in your Twinly app first: your voice cloned and phone
   calling set up (**Voice** and **Phone** in the app). Make one test call
   from the app if you never have.
2. **Settings ▸ Developer API ▸ Create a key**, with the `calls` scope.
3. Keep Twinly running on your Mac. The call goes out from there, under your
   approval mode: if Twinly asks before calling, the script waits for your OK.
4. `cp .env.example .env` and paste your key in.

## Run

```bash
python3 call_agent.py --to "+1 352 555 0199" --goal "Ask if they're open on Sunday"
python3 call_agent.py --to "Mom" --goal "Wish her happy birthday" --say "Hi Mom! Guess who."
```

`--to` is a phone number or a name from your contacts. `--say` sets the first
line (otherwise your twin opens from the goal). Ctrl-C cancels a call that
hasn't started yet; once it's under way, end it in Twinly on your Mac.

Please be decent with it: call people and businesses who'd be fine getting a
call from you, and for a demo, call your own phone.

## Try it with no account

```bash
node ../mock-api/server.js
TWINLY_API_BASE=http://127.0.0.1:4010/v1 \
TWINLY_API_KEY=twk_live_MockKeyForTwinlyExamplesNotARealKey00000000 \
python3 call_agent.py --to "Bella's Bistro" --goal "Book a table for 2 at 7pm"
```

No phone rings: the mock "calls" in about 3 seconds and returns the same
polite 6-line transcript built from your goal.

## Test

```bash
python3 -m unittest discover -s test -v
```

Starts the mock, runs the script against it and checks the transcript, the
opening line, waiting through an approval, an offline Mac, an empty balance,
an unknown contact and a key without the `calls` scope.

## Make it yours

- The answer is plain data: `job["result"]["transcript"]` is a list of
  `{"who": "them" | "twin", "text": ...}` and `outcome` is one line. Save it,
  text it to yourself (`POST /v1/messages`), or put it on a dashboard.
- Waiting costs almost nothing: `wait_for_job` asks
  `GET /v1/jobs/{id}?wait=25`, which the server holds until the call's status
  changes. Rather be told? Set a webhook URL in **Settings ▸ Developer API**
  and Twinly POSTs a signed `call.ended` event when the call is over (see
  `../imessage-bot` for checking the signature).
- Cost: 3 credits ($0.30) per started minute, at least one minute. Calls can
  run up to 30 minutes.
