# web-task-cli

Give your Twinly a job from the terminal. It runs as a full agent task on your
own Mac (browser, apps, files, whatever your Twinly can do), then this script
prints the answer and saves any files it made.

```
$ node task.js "Screenshot the GatorHack schedule page"
Sent to your Twinly (job 5b0c...).
Your Twinly is working on it...

The schedule is up: opening ceremony 9am, hacking ends Sunday 11am...

Saved out/schedule.png (image/png, 48211 bytes)
```

Uses `POST /v1/tasks` and `GET /v1/jobs/{id}`. Node 20 or newer, no packages.

## Setup (5 minutes)

1. In the Twinly Mac app: **Settings ▸ Developer API ▸ Create a key**. Leave
   the `tasks` scope ticked.
2. Keep Twinly running on your Mac. Tasks run there, under your own approval
   mode: if Twinly asks before doing something, the script waits for you.
3. Copy the settings file and paste your key in:

   ```bash
   cp .env.example .env
   ```

## Run

```bash
node task.js "Find the 3 cheapest flights from GNV to SFO next Friday"
node task.js "Make a chart of my calendar this week and save it" --out ./out
```

What you'll see: the job id, "working on it", then the answer. Files land in
`./out` (or `--out`). Ctrl-C cancels a task that hasn't started yet; once
it's running on your Mac, stop it there in Twinly.

If something's wrong you get one line saying what to do: Twinly isn't running
on your Mac, the key is missing a scope, or the account is out of usage
(redeem a code in **Settings ▸ Developer API**).

## Try it with no account

Start the mock API in another terminal, then point the script at it:

```bash
node ../mock-api/server.js
TWINLY_API_BASE=http://127.0.0.1:4010/v1 \
TWINLY_API_KEY=twk_live_MockKeyForTwinlyExamplesNotARealKey00000000 \
node task.js "Take a screenshot of anything"
```

The mock answers every task with the same sentence, and adds a small PNG when
your prompt mentions a screenshot, image or file.

## Test

```bash
npm test
```

Starts the mock, runs `task.js` against it and checks the answer, the saved
file, waiting through an approval, a declined step, an offline Mac and an
empty balance.

## Make it yours

- `task.js` is about 60 lines. The interesting part is three calls:
  `twinly("POST", "/tasks", { prompt })`, `waitForJob(job)`, then read
  `job.result.answer` and `job.result.files`.
- Turn it into a Slack or Discord bot: same three calls inside your message
  handler.
- A task costs 2 credits ($0.20) plus what the model uses. Tasks run up to 15
  minutes. `waitForJob` asks `GET /v1/jobs/{id}?wait=25`, which the server
  holds until something changes, so a long task costs a few requests, not
  hundreds.
