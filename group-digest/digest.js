#!/usr/bin/env node
// Catch up on a group chat: read it through your Twinly, summarize it.
//
//   node digest.js --chat "Hack Squad"
//   node digest.js --with Mom                                (your 1:1 chat with someone)
//   node digest.js --chat "Hack Squad" --limit 50 --post    (also posts the digest into the chat)

import { explain, loadEnv, twinly, waitForJob } from "./twinly.js";

loadEnv();

const opts = { chat: null, with: null, limit: 30, post: false };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--chat") opts.chat = args[++i];
  else if (args[i] === "--with") opts.with = args[++i];
  else if (args[i] === "--limit") opts.limit = Number(args[++i]);
  else if (args[i] === "--post") opts.post = true;
}
if (!opts.chat === !opts.with || !(opts.limit >= 1 && opts.limit <= 50)) {
  console.error('Usage: node digest.js --chat "Group name or id" | --with "Person" [--limit 1-50] [--post]');
  process.exit(2);
}
const label = opts.chat ?? `your chat with ${opts.with}`;

/** Runs a Mac job to the end and returns its result, or throws why it didn't finish. */
async function finished(job) {
  if (job.status !== "done") job = await waitForJob(job);
  if (job.status !== "done") throw Object.assign(new Error(job.error?.message ?? `The job ${job.status}.`), job.error ?? {});
  return job.result;
}

try {
  // 1. Read the chat on your Mac (iMessage stays on your Mac; only these messages come back).
  const who = opts.chat ? { chat: opts.chat } : { with: opts.with };
  const query = new URLSearchParams({ ...who, limit: String(opts.limit) });
  const { messages } = await finished(await twinly("GET", `/messages?${query}`));
  if (messages.length === 0) {
    console.log("That chat has no messages yet.");
    process.exit(0);
  }

  // 2. Turn them into a plain transcript.
  const transcript = messages
    .map((m) => `${m.from === "me" ? "Me" : m.name ?? m.from}: ${m.text}`)
    .join("\n");

  // 3. Ask Twinly's model for the digest (OpenAI-style chat completions).
  const completion = await twinly("POST", "/chat/completions", {
    model: "twinly-core",
    reasoning_effort: "low",
    messages: [
      {
        role: "system",
        content:
          "You write short digests of group chats. Give 3 to 5 bullet points: decisions, plans with times, " +
          "and anything someone asked 'Me' to do. Use only what's in the chat. No preamble.",
      },
      { role: "user", content: `Chat: ${label}\n\n${transcript}` },
    ],
  });
  const digest = completion.choices[0].message.content.trim();
  console.log(`Digest of ${label} (last ${messages.length} messages):\n\n${digest}`);

  // 4. Optionally post it back into the chat, as you.
  if (opts.post) {
    const to = opts.chat ? { chat: opts.chat } : { to: opts.with };
    const sent = await finished(await twinly("POST", "/messages", { ...to, text: `Catch-up:\n${digest}` }));
    console.log(`\nPosted to ${label}${sent.delivered ? " (delivered)" : ""}.`);
  }
} catch (err) {
  console.error(`Error: ${explain(err)}`);
  process.exit(1);
}
