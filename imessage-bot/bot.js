#!/usr/bin/env node
// An @twinly bot. Anyone in a chat texts "@twinly weather Gainesville" and
// your Twinly answers in that chat with the weather.
//
// How it works: your Twinly (on your Mac) sees the message, POSTs a signed
// bot.command webhook here, waits up to 10 seconds, and sends whatever you
// answer with ({"reply": "..."}) back into the chat.

import fs from "node:fs";
import http from "node:http";
import { verifySignature } from "./signature.js";
import { weather } from "./weather.js";

loadEnv();
const SECRET = process.env.TWINLY_WEBHOOK_SECRET;
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const PATH = "/twinly/webhook";

if (!SECRET) {
  console.error("Set TWINLY_WEBHOOK_SECRET in .env (Twinly ▸ Settings ▸ Developer API ▸ Webhooks ▸ Show secret).");
  process.exit(1);
}

// Your commands. Register each name in Twinly ▸ Settings ▸ Developer API ▸ Bot commands.
// Each gets the text after the command and answers with { reply, attachments? }.
const COMMANDS = {
  async weather(args) {
    if (!args) return { reply: "Which city? Try: @twinly weather Gainesville" };
    return { reply: await weather(args) };
  },
};

async function answer({ command, args }) {
  const run = COMMANDS[command];
  if (!run) return { reply: `I don't know "${command}" yet. Try: @twinly weather <city>` };
  // Twinly waits 10 seconds for an answer; reply with something before that.
  let timer;
  const tooSlow = new Promise((r) => {
    timer = setTimeout(() => r({ reply: "That took too long, try again in a minute." }), 8000);
  });
  try {
    return await Promise.race([run(args), tooSlow]);
  } catch (err) {
    console.error(`  ${command} failed: ${err.message}`);
    return { reply: `Sorry, ${command} isn't working right now.` };
  } finally {
    clearTimeout(timer);
  }
}

const seen = new Set(); // event ids already handled, so a retried event runs once

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST" || new URL(req.url, "http://bot").pathname !== PATH) return send(404, { error: "not found" });

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) return send(413, { error: "too large" });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);

  // 1. Only your Twinly knows the secret. Anything else gets a 401.
  if (!verifySignature(SECRET, req.headers["x-twinly-signature"], raw)) {
    console.warn("Rejected a webhook with a bad or old signature.");
    return send(401, { error: "bad signature" });
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return send(400, { error: "not JSON" });
  }
  if (typeof event.id === "string") {
    if (seen.has(event.id)) return send(200, {});
    seen.add(event.id);
    if (seen.size > 500) seen.delete(seen.values().next().value);
  }

  // 2. Other events (job.finished, message.received, ...) just get a thank-you.
  if (event.type !== "bot.command") {
    console.log(`(got ${event.type})`);
    return send(200, {});
  }

  // 3. A command: answer it. The reply goes back into the chat it came from.
  const { command, args, chat, from, from_me } = event.data;
  console.log(`@twinly ${command} ${args}   (from ${from_me ? "you" : from} in ${chat})`);
  const out = await answer(event.data);
  console.log(`  -> ${out.reply}`);
  send(200, out);
});

server.listen(PORT, HOST, () => {
  console.log(`Bot listening on http://${HOST}:${server.address().port}${PATH}`);
});

function loadEnv() {
  const file = new URL("./.env", import.meta.url);
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}
