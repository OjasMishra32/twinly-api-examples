// Checks the mock against docs/developer-api/SPEC-v2.md, so the examples are
// tested against something that behaves like the contract.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { eventually, startMock } from "../testkit.js";

let mock;

before(async () => {
  mock = await startMock();
});
after(async () => {
  await mock.stop();
});
beforeEach(async () => {
  await mock.control("reset", {});
  await mock.config({
    claim_ms: 20,
    run_ms: { "messages.send": 60, "messages.read": 40, "voice.speak": 80, "calls.place": 300, "tasks.run": 250 },
    retry_delays_ms: [50, 100, 150],
  });
});

async function api(method, path, { body, key = mock.key, headers = {} } = {}) {
  const res = await fetch(mock.base + path, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, json: await res.json() };
}

async function pollJob(id, key = mock.key) {
  return eventually(async () => {
    const r = await api("GET", `/jobs/${id}`, { key });
    return ["queued", "running"].includes(r.json.status) ? null : r.json;
  });
}

/** A tiny webhook receiver that records requests and answers with respond(). */
async function receiver(respond = () => ({ status: 200, body: {} })) {
  const got = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const entry = { headers: req.headers, raw, body: JSON.parse(raw) };
    got.push(entry);
    const out = await respond(entry, got.length);
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body ?? {}));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, got, close: () => new Promise((r) => server.close(r)) };
}

function verify(secret, header, raw) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${raw}`).digest("hex");
  return parts.v1 === expected && Math.abs(Date.now() / 1000 - Number(parts.t)) < 300;
}

test("auth: missing key, malformed key, browser origin", async () => {
  let r = await api("GET", "/models", { key: null });
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, "missing_api_key");
  r = await api("GET", "/models", { key: "twk_live_short" });
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, "invalid_api_key");
  r = await api("GET", "/models", { headers: { origin: "https://example.com" } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, "origin_not_allowed");
  r = await api("GET", "/models");
  assert.equal(r.status, 200);
  assert.equal(r.json.data[0].id, "twinly-core");
});

test("the real base path works too", async () => {
  const res = await fetch(`${mock.url}/functions/v1/twinly-api/v1/models`, { headers: { authorization: `Bearer ${mock.key}` } });
  assert.equal(res.status, 200);
});

test("scopes: a chat-only key can chat but not text", async () => {
  const { key } = await mock.control("keys", { name: "chat only", scopes: ["chat"] });
  const chat = await api("POST", "/chat/completions", { key, body: { messages: [{ role: "user", content: "hi" }] } });
  assert.equal(chat.status, 200);
  const r = await api("POST", "/messages", { key, body: { to: "Mom", text: "hi" } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, "scope_missing");
  assert.match(r.json.error.message, /messages\.send/);
  assert.equal((await mock.state()).jobs.length, 0);
});

test("messages.send waits by default and returns 200 done", async () => {
  const r = await api("POST", "/messages", { body: { to: "(555) 555-0101", text: "on my way" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.object, "job");
  assert.equal(r.json.kind, "messages.send");
  assert.equal(r.json.status, "done");
  assert.equal(r.json.result.to, "+15555550101");
  assert.equal(r.json.result.delivered, true);
  assert.equal(r.json.error, null);
  const s = await mock.state();
  assert.equal(s.outbox.length, 1);
  assert.equal(s.outbox[0].text, "on my way");
});

test("?wait=0 answers 202 and the job finishes later", async () => {
  const r = await api("POST", "/messages?wait=0", { body: { chat: "Hack Squad", text: "pizza's here" } });
  assert.equal(r.status, 202);
  assert.equal(r.json.status, "queued");
  const done = await pollJob(r.json.id);
  assert.equal(done.status, "done");
  assert.equal(done.result.to, "chat493021");
});

test("bad requests: wait out of range, both to and chat, long voice text", async () => {
  let r = await api("POST", "/messages?wait=26", { body: { to: "Mom", text: "x" } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.param, "wait");
  r = await api("POST", "/messages", { body: { to: "Mom", chat: "Hack Squad", text: "x" } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "invalid_recipient");
  r = await api("POST", "/messages", { body: { to: "Mom", text: "  " } });
  assert.equal(r.json.error.param, "text");
  r = await api("POST", "/voice/speak", { body: { text: "x".repeat(601) } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.param, "text");
  r = await api("POST", "/messages", { body: { to: "Mom", text: "x", attachments: ["http://example.com/a.jpg"] } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "invalid_attachments");
  assert.equal((await mock.state()).jobs.length, 0);
});

test("messages.read returns the newest messages, oldest first", async () => {
  const r = await api("GET", "/messages?chat=Hack%20Squad&limit=3");
  assert.equal(r.status, 200);
  const m = r.json.result.messages;
  assert.equal(m.length, 3);
  assert.equal(m[2].text, "agreed. I'll rehearse the demo at 3");
  assert.equal(m[1].from, "me");
  assert.equal(m[0].name, "Priya Shah");
  const w = await api("GET", "/messages?with=Mom");
  assert.equal(w.json.result.messages[0].from, "+15555550101");
});

test("calls answer 202, then finish with a transcript, charged per minute", async () => {
  const r = await api("POST", "/calls", { body: { to: "Bella's Bistro", goal: "Book a table for 2 at 7pm", say: "Hi, I'd like a table for two." } });
  assert.equal(r.status, 202);
  const done = await pollJob(r.json.id);
  assert.equal(done.status, "done");
  assert.equal(done.result.minutes, 1);
  assert.equal(done.result.transcript[1].who, "twin");
  assert.equal(done.result.transcript[1].text, "Hi, I'd like a table for two.");
  assert.match(done.result.outcome, /Book a table for 2 at 7pm/);
  const s = await mock.state();
  assert.deepEqual(s.charges.map((c) => [c.kind, c.credits]), [["calls.place", 3]]);
});

test("voice, tasks and images return real media", async () => {
  const v = await api("POST", "/voice/speak", { body: { text: "Happy birthday!" } });
  assert.equal(v.json.status, "done");
  assert.equal(v.json.result.mime, "audio/mp4");
  assert.equal(Buffer.from(v.json.result.audio_b64, "base64").subarray(4, 8).toString(), "ftyp");

  const t = await api("POST", "/tasks?wait=10", { body: { prompt: "Find the cheapest flight and take a screenshot" } });
  assert.equal(t.status, 200);
  assert.match(t.json.result.answer, /cheapest flight/);
  assert.equal(t.json.result.files[0].mime, "image/png");
  assert.equal(Buffer.from(t.json.result.files[0].b64, "base64")[1], 0x50);

  const i = await api("POST", "/images", { body: { prompt: "a gator", shape: "wide" } });
  assert.equal(i.status, 200);
  assert.equal(i.json.data[0].mime, "image/jpeg");
  assert.equal(Buffer.from(i.json.data[0].b64_json, "base64")[0], 0xff);
});

test("offline: 409 twinly_offline at once, and no job", async () => {
  await mock.config({ mac: "offline" });
  const r = await api("POST", "/voice/speak", { body: { text: "hi" } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "twinly_offline");
  assert.equal((await mock.state()).jobs.length, 0);
  assert.equal((await api("POST", "/images", { body: { prompt: "cloud endpoints still work" } })).status, 200);
});

test("a queued job expires as twinly_offline only once the Mac's heartbeat is stale", async () => {
  await mock.config({ mac: "paused", expire_ms: 200 });
  const r = await api("POST", "/messages?wait=0", { body: { to: "Mom", text: "hi" } });
  assert.equal(r.status, 202);
  await new Promise((res) => setTimeout(res, 800));
  assert.equal((await api("GET", `/jobs/${r.json.id}`)).json.status, "queued", "a live Mac's queue doesn't expire at 120 s");
  await mock.config({ mac: "offline" });
  const j = await pollJob(r.json.id);
  assert.equal(j.status, "expired");
  assert.equal(j.error.code, "twinly_offline");
  assert.equal((await mock.state()).charges.length, 0);
});

test("while the Mac is up, a job that never starts expires as queue_timeout", async () => {
  await mock.config({ mac: "paused", queue_timeout_ms: 300 });
  const r = await api("POST", "/tasks", { body: { prompt: "wait in line" } });
  const j = await pollJob(r.json.id);
  assert.equal(j.status, "expired");
  assert.equal(j.error.code, "queue_timeout");
});

test("GET /v1/jobs/{id}?wait holds until the status changes; 202 until it's finished", async () => {
  await mock.config({ run_ms: { "calls.place": 600 } });
  const r = await api("POST", "/calls", { body: { to: "Mom", goal: "Say hi" } });
  assert.equal(r.json.status, "queued");
  const seen = [[r.status, r.json.status]];
  let job = r.json;
  let requests = 0;
  while (!["done", "failed"].includes(job.status)) {
    const g = await api("GET", `/jobs/${job.id}?wait=25`);
    job = g.json;
    seen.push([g.status, job.status]);
    requests += 1;
  }
  assert.deepEqual(seen, [[202, "queued"], [202, "running"], [200, "done"]]);
  assert.equal(requests, 2, "one request per change, no polling");
  assert.equal((await api("GET", `/jobs/${job.id}?wait=99`)).status, 400);
  const t0 = Date.now();
  assert.equal((await api("GET", `/jobs/${job.id}?wait=25`)).json.status, "done");
  assert.ok(Date.now() - t0 < 500, "a finished job answers at once");
});

test("inline attachments: {name, mime, b64} arrive byte for byte", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const r = await api("POST", "/messages", {
    body: { to: "Mom", text: "", attachments: [{ name: "x.png", mime: "IMAGE/PNG", b64: png.toString("base64") }] },
  });
  assert.equal(r.json.status, "done", "text may be empty when there's an attachment");
  const [a] = (await mock.state()).outbox[0].attachments;
  assert.deepEqual([a.source, a.name, a.received, a.bytes, a.content_type, a.detected], ["inline", "x.png", true, png.length, "image/png", "image/png"]);
  assert.equal(a.sha256, crypto.createHash("sha256").update(png).digest("hex"));

  const send = (attachment) => api("POST", "/messages", { body: { to: "Mom", text: "x", attachments: [attachment] } });
  let bad = await send({ name: "../x.png", mime: "image/png", b64: "AAAA" });
  assert.deepEqual([bad.status, bad.json.error.code, bad.json.error.param], [400, "invalid_attachments", "attachments[0].name"]);
  bad = await send({ name: "a.png", b64: "AAAA" });
  assert.equal(bad.json.error.param, "attachments[0].mime");
  bad = await send({ name: "a.png", mime: "image/png", b64: "data:image/png;base64,AAAA" });
  assert.equal(bad.json.error.param, "attachments[0].b64");
  bad = await send("https://localhost/a.png");
  assert.equal(bad.json.error.code, "invalid_attachments");
  bad = await api("POST", "/messages", { body: { to: "Mom", text: "x", attachments: ["https://a/1", "https://a/2", "https://a/3", "https://a/4", "https://a/5"] } });
  assert.equal(bad.status, 400);
});

test("needs_approval holds until the owner decides", async () => {
  await mock.config({ hold: ["messages.send"] });
  const r = await api("POST", "/messages?wait=1", { body: { to: "Mom", text: "hi" } });
  assert.equal(r.status, 202);
  assert.equal(r.json.status, "needs_approval");
  await mock.control(`jobs/${r.json.id}/decide`, { approve: true });
  assert.equal((await pollJob(r.json.id)).status, "done");

  const r2 = await api("POST", "/messages?wait=1", { body: { to: "Mom", text: "again" } });
  await mock.control(`jobs/${r2.json.id}/decide`, { approve: false });
  const j2 = await pollJob(r2.json.id);
  assert.equal(j2.status, "failed");
  assert.equal(j2.error.code, "declined");
});

test("cancel: only a queued job; a running one is the owner's to stop", async () => {
  await mock.config({ mac: "paused" });
  const r = await api("POST", "/tasks", { body: { prompt: "do a thing" } });
  const c = await api("POST", `/jobs/${r.json.id}/cancel`);
  assert.deepEqual([c.status, c.json.status, c.json.error.code], [200, "canceled", "canceled"]);
  assert.equal((await api("POST", `/jobs/${r.json.id}/cancel`)).status, 200, "canceling twice is fine");

  await mock.config({ mac: "online", hold: ["tasks.run"] });
  const held = await api("POST", "/tasks?wait=1", { body: { prompt: "needs a yes" } });
  assert.equal(held.json.status, "needs_approval");
  const c2 = await api("POST", `/jobs/${held.json.id}/cancel`);
  assert.deepEqual([c2.status, c2.json.error.code], [409, "job_running"]);
  const stopped = await mock.control(`jobs/${held.json.id}/stop`, {});
  assert.equal(stopped.status, "canceled");

  const d = await api("POST", "/messages", { body: { to: "Mom", text: "hi" } });
  const c3 = await api("POST", `/jobs/${d.json.id}/cancel`);
  assert.deepEqual([c3.status, c3.json.error.code], [409, "job_finished"]);
});

test("one key can't see another key's jobs", async () => {
  const { key } = await mock.control("keys", { name: "other" });
  const r = await api("POST", "/messages", { body: { to: "Mom", text: "hi" } });
  const other = await api("GET", `/jobs/${r.json.id}`, { key });
  assert.equal(other.status, 404);
  assert.equal(other.json.error.code, "job_not_found");
  assert.equal((await api("GET", "/jobs/not-a-uuid")).status, 404);
});

test("credits: charges show in /v1/usage, failures are free, an empty balance is 402", async () => {
  await mock.config({ balance_credits: 10 });
  await api("POST", "/messages", { body: { to: "Mom", text: "hi" } });
  const failed = await api("POST", "/messages", { body: { to: "Nobody In Contacts", text: "hi" } });
  assert.equal(failed.json.status, "failed");
  assert.equal(failed.json.error.code, "recipient_not_found");
  const u = await api("GET", "/usage");
  assert.equal(u.json.key.usage_usd, 0.05);
  assert.equal(u.json.plan.extra_usage_usd, 0.95);

  await mock.config({ balance_credits: 0.4 });
  const r = await api("POST", "/messages", { body: { to: "Mom", text: "hi" } });
  assert.equal(r.status, 402);
  assert.equal(r.json.error.code, "insufficient_usage");
  assert.equal((await api("POST", "/images", { body: { prompt: "x" } })).status, 402);
  assert.equal((await mock.state()).jobs.length, 2);
});

test("request ceilings: 34 MiB for POST /v1/messages, 6 MB everywhere else", async () => {
  const big = Buffer.alloc(9 * 1024 * 1024, 7).toString("base64"); // a 9 MB file, ~12 MB as JSON
  const ok = await api("POST", "/messages", { body: { to: "Mom", text: "big one", attachments: [{ name: "big.bin", mime: "application/octet-stream", b64: big }] } });
  assert.equal(ok.status, 200);
  assert.equal((await mock.state()).outbox[0].attachments[0].bytes, 9 * 1024 * 1024);
  const img = await api("POST", "/images", { body: { prompt: "x", padding: big } });
  assert.deepEqual([img.status, img.json.error.code], [413, "request_too_large"]);
  const huge = Buffer.alloc(26 * 1024 * 1024, 1).toString("base64"); // ~35 MB as JSON
  const tooBig = await api("POST", "/messages", { body: { to: "Mom", text: "x", attachments: [{ name: "h.bin", mime: "application/octet-stream", b64: huge }] } });
  assert.equal(tooBig.status, 413);
  assert.match(tooBig.json.error.message, /about 25 MB inline/);
});

test("rate limit: 429 rate_limited with Retry-After", async () => {
  await mock.config({ rpm_limit: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await api("GET", "/models")).status, 200);
  const r = await api("GET", "/models");
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, "rate_limited");
  assert.equal(r.headers.get("retry-after"), "10");
});

test("webhooks are signed, retried on non-2xx, and carry the job", async () => {
  const hook = await receiver((_, n) => ({ status: n === 1 ? 500 : 200 }));
  try {
    const { config } = await mock.config({ webhook_url: hook.url });
    const r = await api("POST", "/messages", { body: { to: "Mom", text: "hi" } });
    await eventually(() => hook.got.length >= 2);
    const [first, second] = hook.got;
    assert.equal(first.raw, second.raw);
    assert.equal(second.body.type, "job.finished");
    assert.equal(second.body.data.id, r.json.id);
    assert.equal(second.body.data.status, "done");
    assert.ok(verify(config.webhook_secret, second.headers["x-twinly-signature"], second.raw));
    assert.ok(!verify("wrong secret", second.headers["x-twinly-signature"], second.raw));
    const rec = (await mock.state()).webhooks.find((w) => w.type === "job.finished");
    assert.deepEqual(rec.attempts.map((a) => a.status), [500, 200]);
  } finally {
    await hook.close();
  }
});

test("a call also sends call.ended", async () => {
  const hook = await receiver();
  try {
    await mock.config({ webhook_url: hook.url });
    await api("POST", "/calls?wait=5", { body: { to: "+1 555 555 0199", goal: "Ask if they're open" } });
    const ended = await eventually(() => hook.got.find((g) => g.body.type === "call.ended"));
    assert.equal(ended.body.data.to, "+15555550199");
    assert.equal(ended.body.data.transcript.length, 6);
  } finally {
    await hook.close();
  }
});

test("bot.command: the bot's reply goes back into the chat", async () => {
  const hook = await receiver((e) => ({ status: 200, body: { reply: `got ${e.body.data.command} ${e.body.data.args}` } }));
  try {
    await mock.config({ webhook_url: hook.url, bot_commands: ["weather"] });
    const out = await mock.control("bot-command", { chat: "chat493021", from: "+15555550103", text: "@twinly weather Gainesville FL" });
    assert.equal(out.handled, true);
    assert.equal(out.reply, "got weather Gainesville FL");
    const data = hook.got[0].body.data;
    assert.deepEqual(Object.keys(data).sort(), ["args", "chat", "command", "from", "from_me", "text"]);
    assert.equal(data.from_me, false);
    const s = await mock.state();
    assert.equal(s.outbox.at(-1).via, "bot");
    assert.equal(s.outbox.at(-1).chat, "chat493021");

    const unregistered = await mock.control("bot-command", { text: "@twinly price BTC" });
    assert.equal(unregistered.handled, false);
    assert.equal(hook.got.length, 1);
  } finally {
    await hook.close();
  }
});

test("GET /v1/me: the key, its scopes, and whether the Mac can run jobs right now", async () => {
  const on = await api("GET", "/me");
  assert.equal(on.status, 200);
  assert.equal(on.json.object, "me");
  assert.equal(on.json.mac.online, true);
  assert.ok(on.json.can.mac.includes("POST /v1/tasks"));
  await mock.config({ mac: "offline" });
  const off = await api("GET", "/me");
  assert.equal(off.json.mac.online, false);
  assert.deepEqual(off.json.can.mac, []);
  assert.equal(typeof off.json.mac.hint, "string");
  const { key } = await mock.control("keys", { name: "chat only", scopes: ["chat"] });
  const narrow = await api("GET", "/me", { key });
  assert.deepEqual(narrow.json.can.cloud, ["POST /v1/chat/completions"]);
});

test("tasks with output_schema come back with data of that shape", async () => {
  const schema = { type: "array", items: { type: "object", properties: { airline: { type: "string" }, price: { type: "number" } } } };
  const r = await api("POST", "/tasks", { body: { prompt: "Three flights to Austin", output_schema: schema } });
  const job = await pollJob(r.json.id);
  assert.equal(job.status, "done");
  assert.equal(job.result.data.length, 2);
  assert.equal(typeof job.result.data[0].price, "number");
  const bad = await api("POST", "/tasks", { body: { prompt: "x", output_schema: "json" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.param, "output_schema");
});
