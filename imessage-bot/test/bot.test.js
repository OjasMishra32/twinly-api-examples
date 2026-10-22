// Starts the mock API and the bot, then plays "someone texted @twinly weather"
// through the mock's fake Mac and checks the reply lands back in the chat.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { eventually, startMock } from "../../mock-api/testkit.js";
import { verifySignature } from "../signature.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRET = `whsec_test_${crypto.randomBytes(12).toString("hex")}`;

let mock;
let bot;
let botUrl;
let botLog = "";

before(async () => {
  bot = spawn(process.execPath, [path.join(HERE, "..", "bot.js")], {
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", TWINLY_WEBHOOK_SECRET: SECRET, WEATHER_SOURCE: "sample" },
  });
  bot.stdout.on("data", (d) => (botLog += d));
  bot.stderr.on("data", (d) => (botLog += d));
  botUrl = await eventually(() => /Bot listening on (\S+)/.exec(botLog)?.[1], { timeoutMs: 10_000 });
  mock = await startMock({ config: { webhook_url: botUrl, webhook_secret: SECRET, bot_commands: ["weather"] } });
});

after(async () => {
  await mock.stop();
  bot.kill("SIGTERM");
});

function signed(body, { secret = SECRET, t = Math.floor(Date.now() / 1000) } = {}) {
  const v1 = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

async function postToBot(body, signature) {
  const res = await fetch(botUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...(signature ? { "x-twinly-signature": signature } : {}) },
    body,
  });
  return { status: res.status, json: await res.json() };
}

test("a guest's @twinly weather gets a reply in the same chat", async () => {
  const out = await mock.control("bot-command", { chat: "chat493021", from: "+15555550103", text: "@twinly weather Gainesville" });
  assert.equal(out.handled, true);
  assert.equal(out.status, 200);
  assert.match(out.reply, /^Gainesville: \d+°F and [a-z ]+ \(sample data\)$/);
  const { outbox, webhooks } = await mock.state();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].via, "bot");
  assert.equal(outbox[0].chat, "chat493021");
  assert.equal(outbox[0].text, out.reply);
  assert.equal(webhooks[0].type, "bot.command");
  assert.deepEqual(webhooks[0].attempts.map((a) => a.status), [200]);
  assert.match(botLog, /@twinly weather Gainesville {3}\(from \+15555550103 in chat493021\)/);
});

test("the same city always gets the same sample forecast", async () => {
  const a = await mock.control("bot-command", { text: "@twinly weather gainesville", from_me: true });
  const b = await mock.control("bot-command", { text: "@twinly WEATHER   Gainesville " });
  assert.equal(a.reply, b.reply);
  assert.match(botLog, /\(from you in chat493021\)/);
});

test("no city: the bot asks for one", async () => {
  const out = await mock.control("bot-command", { text: "@twinly weather", from_me: true });
  assert.equal(out.reply, "Which city? Try: @twinly weather Gainesville");
});

test("commands you didn't register never reach the bot", async () => {
  const before = (await mock.state()).webhooks.length;
  const out = await mock.control("bot-command", { text: "@twinly price BTC", from_me: true });
  assert.equal(out.handled, false);
  assert.equal(out.reason, "not_registered");
  assert.equal((await mock.state()).webhooks.length, before);
});

test("other events are acknowledged", async () => {
  const rec = await mock.control("webhooks/test", {});
  assert.equal(rec.ok, true);
  assert.deepEqual(rec.attempts.map((a) => a.status), [200]);
});

test("forged, missing, stale and tampered signatures are all refused", async () => {
  const body = JSON.stringify({ id: "evt_forged", type: "bot.command", data: { command: "weather", args: "X", chat: "c", from: "x", from_me: false, text: "@twinly weather X" } });
  assert.equal((await postToBot(body, signed(body, { secret: "not the secret" }))).status, 401);
  assert.equal((await postToBot(body, null)).status, 401);
  assert.equal((await postToBot(body, signed(body, { t: Math.floor(Date.now() / 1000) - 600 }))).status, 401);
  assert.equal((await postToBot(body.replace("X", "Y"), signed(body))).status, 401);
  const ok = await postToBot(body, signed(body));
  assert.equal(ok.status, 200);
  assert.match(ok.json.reply, /^X: /);
  // The same event id again (a retry) is acknowledged but not run twice.
  const again = await postToBot(body, signed(body));
  assert.deepEqual(again.json, {});
});

test("verifySignature matches the spec's format exactly", () => {
  const body = Buffer.from('{"type":"job.finished"}');
  const t = 1760990000;
  const v1 = crypto.createHmac("sha256", "s3cret").update(`${t}.${body}`).digest("hex");
  const header = `t=${t},v1=${v1}`;
  assert.equal(verifySignature("s3cret", header, body, { nowMs: t * 1000 }), true);
  assert.equal(verifySignature("s3cret", header, body, { nowMs: (t + 301) * 1000 }), false);
  assert.equal(verifySignature("s3cret", `v1=${v1},t=${t}`, body, { nowMs: t * 1000 }), true);
  assert.equal(verifySignature("s3cret", `t=${t},v1=${v1.slice(0, 63)}`, body, { nowMs: t * 1000 }), false);
  assert.equal(verifySignature("", header, body, { nowMs: t * 1000 }), false);
});
