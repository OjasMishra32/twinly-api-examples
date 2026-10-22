// A local stand-in for the Twinly API v2 (docs/developer-api/SPEC-v2.md).
//
// It answers like the real thing: the same paths, auth, scopes, job objects,
// ?wait behaviour, error bodies and signed webhooks. A built-in "fake Mac"
// picks up jobs and finishes them with fixed, deterministic results, so you
// can build and test against it with no account, no key and no real Mac.
//
// It never calls the internet. The one thing it fetches is an attachment URL,
// and only when it points at this machine (127.0.0.1 / localhost) and you
// turned on allow_local_attachments. Inline attachments ({name, mime, b64})
// need no fetching at all.
//
// Run:   node server.js                  (http://127.0.0.1:4010/v1)
// Help:  node server.js --help
// Use from code: import { createMockApi } from "./server.js"

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── The contract's constants ────────────────────────────────────────────────

export const MODEL = "twinly-core";
export const MODEL_CREATED = Math.floor(Date.UTC(2026, 9, 20) / 1000);
// An obviously fake key in the real format (twk_live_ + 43 letters and digits).
export const DEFAULT_KEY = ["twk_live_", "MockKeyForTwinlyExamples", "NotARealKey00000000"].join("");
const KEY_PATTERN = /^twk_live_[0-9A-Za-z]{43}$/;
export const ALL_SCOPES = ["chat", "computer", "images", "messages.send", "messages.read", "calls", "voice", "tasks", "bots"];
const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
// POST /v1/messages carries inline files, so it alone gets a bigger ceiling:
// one ~25 MB file fits; bigger sets go as https URLs.
const MAX_MESSAGE_REQUEST_BYTES = 34 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const LIMITS = { recipient: 128, chat: 256, message: 4000, goal: 2000, say: 1000, speak: 600, prompt: 4000, readLimit: 50 };
const CONTROL = /[\u0000-\u001f\u007f]/;
const MIME = /^[a-z0-9][a-z0-9.+-]{0,62}\/[a-z0-9][a-z0-9.+-]{0,62}$/i;
const DOLLARS_PER_CREDIT = 0.1;

// Credits per job (1 credit = $0.10). calls.place is per started minute.
export const PRICES = {
  "messages.send": 0.5,
  "messages.read": 0.2,
  "voice.speak": 1.0,
  "images": 0.5,
  "tasks.run": 2.0, // base, plus model usage when it finishes
  "calls.place": 3.0, // per started minute, minimum 1
};
const MOCK_TASK_MODEL_USAGE = 0.5; // the "plus model usage" part of a mock task
const MOCK_CHAT_CREDITS = 0.02; // a mock chat completion
const MOCK_NEXT_ACTION_CREDITS = 0.03; // a mock computer next-action

const KINDS = ["messages.send", "messages.read", "calls.place", "voice.speak", "tasks.run"];
const DEFAULT_WAIT = { "messages.send": 25, "messages.read": 25, "calls.place": 0, "voice.speak": 25, "tasks.run": 0 };
const MAX_WAIT = 25;
const TERMINAL = new Set(["done", "failed", "canceled", "expired"]);
const RUN_CEILING_MS = { "calls.place": 30 * 60_000, "tasks.run": 15 * 60_000 };
const DEFAULT_RUN_CEILING_MS = 2 * 60_000;

// ── The fake owner, contacts and chats the fake Mac knows about ─────────────

export const OWNER = { name: "Alex Rivera", handle: "+15555550100" };
const CONTACTS = [
  { name: "Mom", handle: "+15555550101" },
  { name: "Sam Lee", handle: "+15555550102" },
  { name: "Priya Shah", handle: "+15555550103" },
  { name: "Diego Ortiz", handle: "+15555550104" },
  { name: "Bella's Bistro", handle: "+15555550199" },
];

function seedChats() {
  const at = (minute) => new Date(Date.UTC(2026, 9, 18, 14, minute)).toISOString();
  return [
    {
      id: "chat493021",
      name: "Hack Squad",
      participants: ["+15555550102", "+15555550103", "+15555550104"],
      messages: [
        { from: "+15555550102", text: "ok team, demo is at 4pm sharp", at: at(0) },
        { from: "+15555550103", text: "I'll finish the slides by 2", at: at(2) },
        { from: "me", text: "backend is deployed, the login bug is fixed", at: at(5) },
        { from: "+15555550104", text: "can someone grab pizza? I can pay you back", at: at(9) },
        { from: "+15555550102", text: "I'll get pizza, two large, one veggie", at: at(11) },
        { from: "+15555550103", text: "judges want a 3 minute pitch, not 5", at: at(14) },
        { from: "me", text: "then we cut the architecture slide", at: at(15) },
        { from: "+15555550104", text: "agreed. I'll rehearse the demo at 3", at: at(17) },
      ],
    },
    {
      id: "chat100001",
      name: null,
      participants: ["+15555550101"],
      messages: [
        { from: "+15555550101", text: "Are you eating enough at this hackathon?", at: at(20) },
        { from: "me", text: "yes mom, there is pizza", at: at(22) },
      ],
    },
    {
      id: "chat100000",
      name: null,
      participants: [OWNER.handle],
      messages: [{ from: "me", text: "note to self: charge the laptop", at: at(1) }],
    },
  ];
}

// ── Small helpers ───────────────────────────────────────────────────────────

const now = () => Date.now();
const iso = (ms = now()) => new Date(ms).toISOString();
const round = (n, places = 4) => Math.round(n * 10 ** places) / 10 ** places;
const dollars = (credits) => Math.round(Math.max(0, credits) * DOLLARS_PER_CREDIT * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readFixture(name) {
  return fs.readFileSync(path.join(HERE, "fixtures", name));
}

/** "X-Twinly-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<unix>.<body>")>" */
export function signatureHeader(secret, body, unix = Math.floor(now() / 1000)) {
  const mac = crypto.createHmac("sha256", secret).update(`${unix}.${body}`).digest("hex");
  return `t=${unix},v1=${mac}`;
}

function errorType(status) {
  if (status === 401) return "authentication_error";
  if (status === 402) return "insufficient_quota";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

class ApiError extends Error {
  constructor(status, message, code, { param = null, headers = {} } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.param = param;
    this.headers = headers;
  }
}

function digits(s) {
  return String(s).replace(/\D/g, "");
}

function normalizeHandle(raw) {
  const s = String(raw).trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return s.toLowerCase();
  if (/^[+(\d][\d\s().-]{6,}$/.test(s) && digits(s).length >= 7) {
    const d = digits(s);
    if (d.length === 10) return `+1${d}`;
    if (d.length === 11 && d.startsWith("1")) return `+${d}`;
    return `+${d}`;
  }
  return null;
}

function contactName(handle) {
  if (handle === OWNER.handle) return OWNER.name;
  return CONTACTS.find((c) => c.handle === handle)?.name ?? null;
}

function sniff(buf) {
  if (buf.length >= 8 && buf.slice(4, 8).toString("latin1") === "ftyp") return "audio/mp4";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  return "application/octet-stream";
}

function isLocalUrl(u) {
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
}

// ── The server ──────────────────────────────────────────────────────────────

function defaultConfig() {
  return {
    // The Mac: "online" (heartbeat fresh, picks up jobs), "offline" (heartbeat
    // older than 90 s, so Mac endpoints answer 409 twinly_offline), or "paused"
    // (heartbeat fresh but nothing gets picked up, so jobs expire).
    mac: "online",
    // The account's usage balance in credits ($20 voucher = 200 credits).
    // Set it to 0 to see 402 insufficient_usage.
    balance_credits: 200,
    rpm_limit: 30,
    // Job kinds the owner's approval mode holds (needs_approval until decided).
    hold: [],
    claim_ms: 150,
    run_ms: { "messages.send": 400, "messages.read": 300, "voice.speak": 600, "calls.place": 2500, "tasks.run": 2000 },
    // A queued job expires as twinly_offline after 120 s if the Mac's heartbeat
    // is stale; while the Mac is up it may wait (behind a call, say) for 30 min,
    // then expires as queue_timeout.
    expire_ms: 120_000,
    queue_timeout_ms: 30 * 60_000,
    run_ceiling_ms: null, // override every kind's hard ceiling (for testing timeouts)
    // Webhooks (Settings ▸ Developer API on the real Mac).
    webhook_url: null,
    webhook_secret: `whsec_mock_${crypto.randomBytes(16).toString("hex")}`,
    retry_delays_ms: [1000, 4000, 15000],
    webhook_timeout_ms: 10_000,
    bot_commands: [],
    bot_timeout_ms: 10_000,
    guest_bot_per_minute: 6,
    message_received_chats: [],
    // Attachments: the real Mac downloads https URLs. The mock fetches only
    // URLs on this machine, and only when this is on (tests turn it on).
    allow_local_attachments: false,
    // A fixed reply for POST /v1/chat/completions (otherwise a stock line).
    chat_reply: null,
  };
}

export function createMockApi(options = {}) {
  const fixtures = {
    m4a: readFixture("voice.m4a"),
    png: readFixture("result.png"),
    jpg: {
      square: readFixture("image-square.jpg"),
      wide: readFixture("image-wide.jpg"),
      tall: readFixture("image-tall.jpg"),
    },
  };

  let config;
  let state;
  const timers = new Set();

  function later(ms, fn) {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  }

  function reset(overrides = {}) {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    config = { ...defaultConfig(), ...(options.config ?? {}), ...overrides };
    state = {
      keys: new Map(),
      jobs: new Map(),
      chats: seedChats(),
      outbox: [],
      calls: [],
      chatRequests: [],
      webhooks: [],
      botCommands: [],
      charges: [],
      reserved: 0,
      rate: new Map(),
      guestBot: new Map(),
      running: new Set(),
    };
    addKey({ key: options.key ?? DEFAULT_KEY, name: "Mock key", scopes: ALL_SCOPES });
  }

  function addKey({ key, name = "Extra key", scopes = ALL_SCOPES } = {}) {
    const token = key ?? `twk_live_${crypto.randomBytes(48).toString("base64").replace(/[^0-9A-Za-z]/g, "").slice(0, 43)}`;
    if (!KEY_PATTERN.test(token)) throw new Error("A key must be twk_live_ plus 43 letters and digits.");
    const bad = scopes.filter((s) => !ALL_SCOPES.includes(s));
    if (bad.length) throw new Error(`Unknown scope(s): ${bad.join(", ")}`);
    const entry = { id: crypto.randomUUID(), name, prefix: token.slice(0, 15), scopes: [...scopes], revoked: false, requests: 0 };
    state.keys.set(token, entry);
    return { key: token, ...entry };
  }

  // ── Jobs and the fake Mac ────────────────────────────────────────────────

  function publicJob(j) {
    return {
      id: j.id,
      object: "job",
      kind: j.kind,
      status: j.status,
      created_at: iso(j.created_at),
      updated_at: iso(j.updated_at),
      result: j.status === "done" ? j.result : null,
      error: j.error ?? null,
    };
  }

  function setStatus(j, status, { result, error } = {}) {
    j.status = status;
    j.updated_at = now();
    if (result !== undefined) j.result = result;
    if (error !== undefined) j.error = error;
    if (TERMINAL.has(status)) {
      state.running.delete(j.id);
      settleCharge(j);
      if (j.ceilingTimer) clearTimeout(j.ceilingTimer);
      // The Mac posts job.finished for jobs it finished. An expired job never
      // reached a Mac, and a job canceled while still queued never did either.
      if (status !== "expired" && !(status === "canceled" && !j.claimed_at)) {
        emit("job.finished", publicJob(j));
      }
      later(0, pump);
    }
    for (const w of [...j.waiters]) w();
  }

  function sweep() {
    const stale = config.mac === "offline";
    for (const j of state.jobs.values()) {
      if (j.status !== "queued") continue;
      const age = now() - j.created_at;
      if (stale && age >= config.expire_ms) {
        setStatus(j, "expired", {
          error: { code: "twinly_offline", message: "Your Twinly didn't pick this job up within 2 minutes. Open Twinly on your Mac and try again." },
        });
      } else if (!stale && age >= config.queue_timeout_ms) {
        setStatus(j, "expired", {
          error: { code: "queue_timeout", message: "Your Twinly was busy with another job and didn't get to this one within 30 minutes." },
        });
      }
    }
  }

  function exclusive(kind) {
    return kind === "calls.place" || kind === "tasks.run";
  }

  /** Start queued jobs: at most 2 at once, calls and tasks never together. */
  function pump() {
    if (config.mac !== "online") return;
    const queued = [...state.jobs.values()].filter((j) => j.status === "queued" && !j.claiming).sort((a, b) => a.created_at - b.created_at);
    for (const j of queued) {
      const running = [...state.running].map((id) => state.jobs.get(id));
      if (running.length >= 2) return;
      if (exclusive(j.kind) && running.some((r) => exclusive(r.kind))) continue;
      j.claiming = true;
      state.running.add(j.id);
      later(config.claim_ms, () => claim(j));
    }
  }

  function claim(j) {
    j.claiming = false;
    if (j.status !== "queued" || config.mac !== "online") {
      state.running.delete(j.id);
      return;
    }
    j.claimed_at = now();
    setStatus(j, "running");
    const ceiling = config.run_ceiling_ms ?? RUN_CEILING_MS[j.kind] ?? DEFAULT_RUN_CEILING_MS;
    j.ceilingTimer = later(ceiling, () => {
      if (j.status === "running") setStatus(j, "failed", { error: { code: "timeout", message: "The job ran past its time limit on the Mac." } });
    });
    const runMs = config.run_ms[j.kind] ?? 300;
    if (config.hold.includes(j.kind)) {
      later(Math.min(runMs, 200), () => {
        if (j.status === "running") setStatus(j, "needs_approval");
      });
      return;
    }
    later(runMs, () => execute(j));
  }

  async function execute(j) {
    if (j.status !== "running") return;
    try {
      const result = await run(j);
      if (j.status === "running") setStatus(j, "done", { result });
    } catch (e) {
      if (j.status === "running") setStatus(j, "failed", { error: { code: e.code ?? "mac_error", message: e.message } });
    }
  }

  function decide(id, approve) {
    const j = state.jobs.get(id);
    if (!j) throw new Error("No such job.");
    if (j.status !== "needs_approval") throw new Error(`The job is ${j.status}, not needs_approval.`);
    if (!approve) {
      setStatus(j, "failed", { error: { code: "declined", message: "The owner declined this in Twinly." } });
      return publicJob(j);
    }
    j.status = "running";
    j.updated_at = now();
    for (const w of [...j.waiters]) w();
    later(Math.min(config.run_ms[j.kind] ?? 300, 300), () => execute(j));
    return publicJob(j);
  }

  function macFail(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  function resolvePerson(raw) {
    const handle = normalizeHandle(raw);
    if (handle) return handle;
    const c = CONTACTS.find((x) => x.name.toLowerCase() === String(raw).trim().toLowerCase());
    if (c) return c.handle;
    if (String(raw).trim().toLowerCase() === "me") return OWNER.handle;
    throw macFail("recipient_not_found", `Twinly couldn't find "${raw}" in your contacts. Send a phone number or email instead.`);
  }

  function resolveChat(raw) {
    const q = String(raw).trim().toLowerCase();
    const c = state.chats.find((x) => x.id.toLowerCase() === q || (x.name && x.name.toLowerCase() === q));
    if (!c) throw macFail("chat_not_found", `Twinly couldn't find a chat called "${raw}".`);
    return c;
  }

  function chatWith(handle) {
    let c = state.chats.find((x) => x.participants.length === 1 && x.participants[0] === handle);
    if (!c) {
      c = { id: `chat${100002 + state.chats.length}`, name: null, participants: [handle], messages: [] };
      state.chats.push(c);
    }
    return c;
  }

  async function download(url) {
    const u = new URL(url);
    if (!(isLocalUrl(u) && config.allow_local_attachments)) {
      return { source: "url", url, received: false, note: "The mock records remote URLs without fetching them (the real Mac downloads them)." };
    }
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw macFail("attachment_unavailable", `Twinly couldn't download ${url} (${e.message}).`);
    }
    if (!res.ok) throw macFail("attachment_unavailable", `Twinly couldn't download ${url} (HTTP ${res.status}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ATTACHMENT_BYTES) throw macFail("attachment_too_large", `${url} is over 25 MB.`);
    return {
      source: "url",
      url,
      received: true,
      bytes: buf.length,
      sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      content_type: res.headers.get("content-type"),
      detected: sniff(buf),
      name: decodeURIComponent(u.pathname.split("/").pop() || "attachment"),
    };
  }

  function inline(a) {
    const buf = Buffer.from(a.b64, "base64");
    return {
      source: "inline",
      name: a.name,
      received: true,
      bytes: buf.length,
      sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      content_type: a.mime,
      detected: sniff(buf),
    };
  }

  async function deliver({ chat, to, text, attachments = [], via, jobId = null }) {
    const files = [];
    for (const a of attachments) files.push(typeof a === "string" ? await download(a) : inline(a));
    const sentAt = iso();
    const entry = { job_id: jobId, via, to, chat: chat.id, text, attachments: files, sent_at: sentAt };
    state.outbox.push(entry);
    chat.messages.push({ from: "me", text, at: sentAt, attachments: files.length });
    return entry;
  }

  async function run(j) {
    const p = j.payload;
    switch (j.kind) {
      case "messages.send": {
        let chat;
        let to;
        if (p.chat !== undefined) {
          chat = resolveChat(p.chat);
          to = chat.id;
        } else {
          to = resolvePerson(p.to);
          chat = chatWith(to);
        }
        const entry = await deliver({ chat, to, text: p.text, attachments: p.attachments ?? [], via: "api", jobId: j.id });
        return { to, delivered: true, sent_at: entry.sent_at };
      }
      case "messages.read": {
        const chat = p.chat !== undefined ? resolveChat(p.chat) : chatWith(resolvePerson(p.with));
        const messages = chat.messages.slice(-p.limit).map((m) => ({
          from: m.from,
          name: m.from === "me" ? null : contactName(m.from),
          text: m.text,
          at: m.at,
        }));
        return { messages };
      }
      case "calls.place": {
        const to = resolvePerson(p.to);
        const goal = p.goal.trim().replace(/[.!]+$/, "");
        const ask = goal.charAt(0).toLowerCase() + goal.slice(1);
        const transcript = [
          { who: "them", text: "Hi, thanks for calling. How can I help you?" },
          { who: "twin", text: p.say ? p.say : `Hi! I'm calling to ${ask}.` },
          { who: "them", text: "Sure, I can help with that. What name should I put down?" },
          { who: "twin", text: `It's ${OWNER.name.split(" ")[0]}.` },
          { who: "them", text: "Perfect, you're all set. Anything else?" },
          { who: "twin", text: "That's everything. Thank you so much, bye!" },
        ];
        const result = { minutes: 1, transcript, outcome: `Done: ${goal} (mock call, no phone was used).` };
        state.calls.push({ job_id: j.id, to, goal: p.goal, say: p.say ?? null, ...result });
        emit("call.ended", { job_id: j.id, to, ...result });
        return result;
      }
      case "voice.speak":
        return { audio_b64: fixtures.m4a.toString("base64"), mime: "audio/mp4", seconds: 1.2 };
      case "tasks.run": {
        const wantsFile = /screenshot|image|picture|photo|png|jpe?g|file|chart/i.test(p.prompt);
        const short = p.prompt.length > 120 ? `${p.prompt.slice(0, 117)}...` : p.prompt;
        const result = {
          answer: `Mock answer: I worked on "${short}". With the real API, your own Twinly runs this task on your Mac and answers here.`,
          files: wantsFile ? [{ name: "result.png", mime: "image/png", b64: fixtures.png.toString("base64") }] : [],
        };
        // A real task fills the shape with what it found; the mock fills it
        // with placeholders of the right types so code can be built against it.
        if (p.output_schema) result.data = sampleFor(p.output_schema);
        return result;
      }
    }
    throw macFail("unknown_kind", j.kind);
  }

  /** A value of the shape a JSON Schema describes: strings, numbers, booleans,
   *  objects with every property, arrays with two items, enums' first value. */
  function sampleFor(schema, depth = 0) {
    if (!schema || typeof schema !== "object" || depth > 6) return null;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
    const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
    switch (type) {
      case "object": {
        const out = {};
        for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = sampleFor(v, depth + 1);
        return out;
      }
      case "array": return [sampleFor(schema.items, depth + 1), sampleFor(schema.items, depth + 1)];
      case "number": return 12.5;
      case "integer": return 3;
      case "boolean": return true;
      case "string": return "example";
      default: return schema.properties ? sampleFor({ ...schema, type: "object" }, depth) : null;
    }
  }

  // ── Billing (credits) ────────────────────────────────────────────────────

  function available() {
    return round(config.balance_credits - state.reserved);
  }

  function requireCredits(credits, what) {
    if (available() + 1e-9 < credits) {
      throw new ApiError(402,
        `Your Twinly account doesn't have enough usage left for ${what} (${credits} credits, $${(credits * DOLLARS_PER_CREDIT).toFixed(2)}). Redeem a code or add extra usage in the Twinly app.`,
        "insufficient_usage");
    }
  }

  function charge(keyEntry, kind, credits, jobId = null) {
    const c = round(Math.min(credits, Math.max(0, config.balance_credits)));
    config.balance_credits = round(config.balance_credits - c);
    state.charges.push({ key_id: keyEntry.id, kind, credits: c, job_id: jobId, at: iso() });
  }

  /** A job reserves its minimum at creation; it's charged only if it finishes done. */
  function settleCharge(j) {
    if (j.settled) return;
    j.settled = true;
    state.reserved = round(Math.max(0, state.reserved - j.reservedCredits));
    if (j.status !== "done") return;
    let credits = PRICES[j.kind];
    if (j.kind === "tasks.run") credits += MOCK_TASK_MODEL_USAGE;
    if (j.kind === "calls.place") credits = PRICES["calls.place"] * Math.max(1, Math.ceil(j.result?.minutes ?? 1));
    charge(j.keyEntry, j.kind, credits, j.id);
  }

  // ── Webhooks (what the real Mac POSTs) ───────────────────────────────────

  async function post(url, body, timeoutMs) {
    const headers = {
      "content-type": "application/json",
      "user-agent": "Twinly-Webhooks/2 (mock)",
      "x-twinly-signature": signatureHeader(config.webhook_secret, body),
    };
    try {
      const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      return { status: 0, text: "", error: e.name === "TimeoutError" ? "timeout" : e.message };
    }
  }

  /**
   * Sends one event. Every event retries 3 times on a non-2xx (1/4/15 s),
   * except bot.command: one try that waits up to 10 s for the bot's reply.
   */
  async function deliverEvent(type, data, { retry = true, timeoutMs = config.webhook_timeout_ms } = {}) {
    if (!config.webhook_url) return null;
    const event = { id: `evt_${crypto.randomUUID()}`, type, created_at: iso(), data };
    const body = JSON.stringify(event);
    const record = { id: event.id, type, url: config.webhook_url, body: event, attempts: [], ok: false, response: null };
    state.webhooks.push(record);
    const delays = retry ? [0, ...config.retry_delays_ms] : [0];
    for (const delay of delays) {
      if (delay) await sleep(delay);
      const r = await post(config.webhook_url, body, timeoutMs);
      record.attempts.push({ at: iso(), status: r.status, ...(r.error ? { error: r.error } : {}) });
      if (r.status >= 200 && r.status < 300) {
        record.ok = true;
        record.response = r.text;
        break;
      }
    }
    return record;
  }

  function emit(type, data) {
    deliverEvent(type, data).catch(() => {});
  }

  async function botCommand({ text, chat, from, from_me = false }) {
    const m = /^\s*@twinly\s+(\S+)\s*([\s\S]*)$/i.exec(String(text ?? ""));
    if (!m) throw new Error('text must look like "@twinly <command> <rest>".');
    const command = m[1].toLowerCase();
    const args = m[2].trim();
    const c = resolveChat(chat ?? "chat493021");
    const sender = from_me ? OWNER.handle : (from ? normalizeHandle(from) ?? from : c.participants[0]);
    const outcome = { command, args, chat: c.id, from: sender, from_me: Boolean(from_me) };
    state.botCommands.push(outcome);
    if (!config.bot_commands.map((x) => x.toLowerCase()).includes(command)) return { ...outcome, handled: false, reason: "not_registered" };
    if (![...state.keys.values()].some((k) => !k.revoked && k.scopes.includes("bots"))) {
      return { ...outcome, handled: false, reason: "no_key_with_bots_scope" };
    }
    if (!config.webhook_url) return { ...outcome, handled: false, reason: "no_webhook_url" };
    if (!from_me) {
      const recent = (state.guestBot.get(sender) ?? []).filter((t) => now() - t < 60_000);
      if (recent.length >= config.guest_bot_per_minute) return { ...outcome, handled: false, reason: "guest_rate_limited" };
      recent.push(now());
      state.guestBot.set(sender, recent);
    }
    const record = await deliverEvent("bot.command", { command, args, chat: c.id, from: sender, from_me: Boolean(from_me), text: String(text) },
      { retry: false, timeoutMs: config.bot_timeout_ms });
    const status = record.attempts[0]?.status ?? 0;
    if (!record.ok) return { ...outcome, handled: true, status, reply: null, error: record.attempts[0]?.error ?? `HTTP ${status}` };
    let reply = null;
    let attachments = [];
    try {
      const parsed = JSON.parse(record.response || "{}");
      if (typeof parsed.reply === "string" && parsed.reply.trim()) reply = parsed.reply;
      if (Array.isArray(parsed.attachments)) {
        attachments = parsed.attachments
          .filter((a) => typeof a === "string" || (isObject(a) && nonEmpty(a.name) && nonEmpty(a.mime) && typeof a.b64 === "string"))
          .slice(0, 4);
      }
    } catch {
      return { ...outcome, handled: true, status, reply: null, error: "The bot's response wasn't JSON." };
    }
    if (!reply && attachments.length === 0) return { ...outcome, handled: true, status, reply: null };
    const sent = await deliver({ chat: c, to: c.id, text: reply ?? "", attachments, via: "bot" });
    return { ...outcome, handled: true, status, reply, attachments, sent };
  }

  // ── HTTP plumbing ────────────────────────────────────────────────────────

  function send(res, status, body, headers = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    });
    res.end(text);
  }

  function sendError(res, e) {
    send(res, e.status, { error: { message: e.message, type: errorType(e.status), code: e.code, param: e.param } }, e.headers);
  }

  function tooLarge(name) {
    return new ApiError(413, name === "messages.send"
      ? "Request is too large: a message can carry about 25 MB inline. Send bigger files as https URLs."
      : "Request is too large.", "request_too_large");
  }

  const bodyCap = (name) => (name === "messages.send" ? MAX_MESSAGE_REQUEST_BYTES : MAX_REQUEST_BYTES);

  async function readBody(req, name) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > bodyCap(name)) throw tooLarge(name);
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function jsonBody(req, name) {
    const text = await readBody(req, name);
    try {
      const v = JSON.parse(text);
      if (!isObject(v)) throw new Error();
      return v;
    } catch {
      throw new ApiError(400, "The body must be a JSON object.", "invalid_json");
    }
  }

  function routePath(url) {
    const p = new URL(url, "http://mock").pathname.replace(/\/+$/, "") || "/";
    const at = p.indexOf("/twinly-api");
    return at === -1 ? p : p.slice(at + "/twinly-api".length) || "/";
  }

  const ROUTES = [
    { path: "/health", GET: "health" },
    { path: "/v1/models", GET: "models" },
    { path: `/v1/models/${MODEL}`, GET: "model" },
    { path: "/v1/usage", GET: "usage" },
    { path: "/v1/me", GET: "me" },
    { path: "/v1/chat/completions", POST: "chat" },
    { path: "/v1/computer/next-action", POST: "next-action" },
    { path: "/v1/images", POST: "images" },
    { path: "/v1/messages", POST: "messages.send", GET: "messages.read" },
    { path: "/v1/calls", POST: "calls.place" },
    { path: "/v1/voice/speak", POST: "voice.speak" },
    { path: "/v1/tasks", POST: "tasks.run" },
  ];

  function match(p) {
    const r = ROUTES.find((x) => x.path === p);
    if (r) return { route: r };
    let m = /^\/v1\/jobs\/([^/]+)$/.exec(p);
    if (m) return { route: { path: p, GET: "job.get" }, jobId: m[1] };
    m = /^\/v1\/jobs\/([^/]+)\/cancel$/.exec(p);
    if (m) return { route: { path: p, POST: "job.cancel" }, jobId: m[1] };
    return null;
  }

  function authenticate(req) {
    const header = req.headers.authorization;
    const token = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header ?? "")?.[1];
    if (!token) {
      throw new ApiError(401, "Send your Twinly API key as 'Authorization: Bearer twk_live_...'.", "missing_api_key",
        { headers: { "www-authenticate": "Bearer" } });
    }
    const entry = KEY_PATTERN.test(token) ? state.keys.get(token) : null;
    if (!entry || entry.revoked) {
      throw new ApiError(401, "This API key isn't valid. It may have been revoked; create a new one in Twinly ▸ Settings ▸ Developer API.",
        "invalid_api_key", { headers: { "www-authenticate": "Bearer" } });
    }
    return entry;
  }

  function rateLimit(entry) {
    const recent = (state.rate.get(entry.id) ?? []).filter((t) => now() - t < 60_000);
    if (recent.length >= config.rpm_limit) {
      throw new ApiError(429, `This key is limited to ${config.rpm_limit} requests a minute. Slow down and retry.`, "rate_limited",
        { headers: { "retry-after": "10" } });
    }
    recent.push(now());
    state.rate.set(entry.id, recent);
    entry.requests += 1;
  }

  const SCOPE_FOR = {
    chat: "chat", "next-action": "computer", images: "images",
    "messages.send": "messages.send", "messages.read": "messages.read",
    "calls.place": "calls", "voice.speak": "voice", "tasks.run": "tasks",
  };

  function requireScope(entry, name) {
    const scope = SCOPE_FOR[name];
    if (scope && !entry.scopes.includes(scope)) {
      throw new ApiError(403, `This key doesn't have the '${scope}' scope. Turn it on for this key in Twinly ▸ Settings ▸ Developer API.`,
        "scope_missing", { param: scope });
    }
  }

  const bad = (message, param, code = "invalid_parameter") => new ApiError(400, message, code, { param });
  const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;

  function parseWait(query, kind) {
    const raw = query.get("wait");
    if (raw === null) return DEFAULT_WAIT[kind] ?? 0;
    if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) > MAX_WAIT) throw bad("wait must be a number of seconds from 0 to 25.", "wait");
    return Number(raw);
  }

  /** A one-line value (a recipient, a chat): trimmed, no control characters. */
  function line(raw, param, max, required) {
    if (raw === undefined || raw === null) {
      if (required) throw bad(`${param} is required.`, param);
      return undefined;
    }
    if (typeof raw !== "string") throw bad(`${param} must be a string.`, param);
    const value = raw.trim();
    if (!value) {
      if (required) throw bad(`${param} can't be empty.`, param);
      return undefined;
    }
    if (value.length > max) throw bad(`${param} is limited to ${max} characters.`, param);
    if (CONTROL.test(value)) throw bad(`${param} can't contain control characters.`, param);
    return value;
  }

  /** Free text (newlines allowed). */
  function freeText(raw, param, max, required) {
    if (raw === undefined || raw === null) {
      if (required) throw bad(`${param} is required.`, param);
      return undefined;
    }
    if (typeof raw !== "string") throw bad(`${param} must be a string.`, param);
    if (raw.length > max) throw bad(`${param} is limited to ${max} characters.`, param);
    if (raw.includes("\u0000")) throw bad(`${param} can't contain a NUL character.`, param);
    if (required && !raw.trim()) throw bad(`${param} can't be empty.`, param);
    return raw;
  }

  function attachmentUrlOk(raw) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    // The mock's one exception: local http links, so tests can serve a file.
    if (config.allow_local_attachments && u.protocol === "http:" && isLocalUrl(u)) return true;
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    if (!host || host.startsWith("[") || !host.includes(".") || /^[0-9.]+$/.test(host)) return false;
    return !/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/.test(host);
  }

  function base64Bytes(b64) {
    if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return -1;
    return (b64.length / 4) * 3 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  }

  function validateAttachments(v) {
    if (v === undefined || v === null) return undefined;
    const no = (message, param) => bad(message, param, "invalid_attachments");
    if (!Array.isArray(v)) throw no("attachments must be an array of https URLs or {name, mime, b64} files.", "attachments");
    if (v.length > 4) throw no("At most 4 attachments.", "attachments");
    return v.map((a, i) => {
      const where = `attachments[${i}]`;
      if (typeof a === "string") {
        if (!attachmentUrlOk(a.trim())) throw no("Each attachment URL must be https on a public host name.", where);
        return a.trim();
      }
      if (!isObject(a)) throw no("Each attachment is an https URL or a {name, mime, b64} file.", where);
      const name = typeof a.name === "string" ? a.name.trim() : "";
      if (!name || name.length > 255 || CONTROL.test(name) || /[/\\]/.test(name) || name === "." || name === "..") {
        throw no("Each inline attachment needs a plain file name (no folders), up to 255 characters.", `${where}.name`);
      }
      if (typeof a.mime !== "string" || !MIME.test(a.mime)) throw no('Each inline attachment needs a mime type, like "image/jpeg".', `${where}.mime`);
      if (typeof a.b64 !== "string") throw no("Each inline attachment needs its bytes as standard base64 in b64.", `${where}.b64`);
      const bytes = base64Bytes(a.b64);
      if (bytes <= 0) throw no("b64 must be standard, padded base64 of a non-empty file (no data: prefix).", `${where}.b64`);
      if (bytes > MAX_ATTACHMENT_BYTES) throw bad("Each attachment is limited to 25 MB.", `${where}.b64`, "attachment_too_large");
      return { name, mime: a.mime.toLowerCase(), b64: a.b64 };
    });
  }

  function validateJob(kind, body, query) {
    switch (kind) {
      case "messages.send": {
        const to = line(body.to, "to", LIMITS.recipient, false);
        const chat = line(body.chat, "chat", LIMITS.chat, false);
        if ((to === undefined) === (chat === undefined)) {
          throw bad("Send exactly one of to (a phone number, email or contact) or chat (a chat id or name).", "to", "invalid_recipient");
        }
        const attachments = validateAttachments(body.attachments);
        const text = freeText(body.text, "text", LIMITS.message, false);
        if (text === undefined) throw bad("text is required.", "text");
        if (!text.trim() && !attachments?.length) throw bad("text can't be empty unless you send an attachment.", "text");
        return { ...(to !== undefined ? { to } : { chat }), text, ...(attachments?.length ? { attachments } : {}) };
      }
      case "messages.read": {
        const chat = line(query.get("chat") ?? undefined, "chat", LIMITS.chat, false);
        const withWho = line(query.get("with") ?? undefined, "with", LIMITS.recipient, false);
        if ((chat === undefined) === (withWho === undefined)) {
          throw bad("Send exactly one of chat (a chat id or name) or with (a phone number, email or contact).", "chat", "invalid_recipient");
        }
        const rawLimit = query.get("limit");
        let limit = 20;
        if (rawLimit !== null) {
          if (!/^\d+$/.test(rawLimit.trim()) || Number(rawLimit) < 1 || Number(rawLimit) > LIMITS.readLimit) {
            throw bad("limit must be a whole number from 1 to 50.", "limit");
          }
          limit = Number(rawLimit);
        }
        return { ...(chat !== undefined ? { chat } : { with: withWho }), limit };
      }
      case "calls.place": {
        const to = line(body.to, "to", LIMITS.recipient, true);
        const goal = freeText(body.goal, "goal", LIMITS.goal, true);
        const say = freeText(body.say, "say", LIMITS.say, false);
        return { to, goal, ...(say?.trim() ? { say } : {}) };
      }
      case "voice.speak":
        return { text: freeText(body.text, "text", LIMITS.speak, true) };
      case "tasks.run": {
        const prompt = freeText(body.prompt, "prompt", LIMITS.prompt, true);
        const schema = body.output_schema;
        if (schema === undefined || schema === null) return { prompt };
        if (typeof schema !== "object" || Array.isArray(schema)) {
          throw bad('"output_schema" must be a JSON Schema object, like {"type":"object","properties":{...}}.', "output_schema");
        }
        if (Buffer.byteLength(JSON.stringify(schema)) > 8000) throw bad('"output_schema" can be at most 8000 bytes.', "output_schema");
        return { prompt, output_schema: schema };
      }
    }
    throw new Error(kind);
  }

  /** Resolves when ready() is true for the job, or after `seconds`. */
  function waitFor(j, seconds, ready = () => TERMINAL.has(j.status)) {
    if (ready() || seconds <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let timer;
      const done = () => {
        if (!ready()) return;
        clearTimeout(timer);
        j.waiters.delete(done);
        resolve();
      };
      timer = setTimeout(() => {
        j.waiters.delete(done);
        resolve();
      }, seconds * 1000);
      j.waiters.add(done);
    });
  }

  async function createJob(req, res, entry, kind, query) {
    const body = req.method === "POST" ? await jsonBody(req, kind) : {};
    const payload = validateJob(kind, body, query);
    const wait = parseWait(query, kind);
    if (config.mac === "offline") {
      throw new ApiError(409, "Your Twinly isn't running. Open Twinly on your Mac and try again.", "twinly_offline");
    }
    const minimum = PRICES[kind];
    requireCredits(minimum, `this ${kind} job`);
    state.reserved = round(state.reserved + minimum);
    const j = {
      id: crypto.randomUUID(), kind, payload, status: "queued", result: null, error: null,
      created_at: now(), updated_at: now(), claimed_at: null,
      keyEntry: entry, reservedCredits: minimum, waiters: new Set(),
    };
    state.jobs.set(j.id, j);
    pump();
    await waitFor(j, wait);
    send(res, TERMINAL.has(j.status) ? 200 : 202, publicJob(j));
  }

  function ownJob(entry, id) {
    const j = UUID.test(id) ? state.jobs.get(id.toLowerCase()) : null;
    // A key sees only the jobs it created.
    if (!j || j.keyEntry.id !== entry.id) throw new ApiError(404, "No job with that id for this key.", "job_not_found");
    return j;
  }

  function lastUserText(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== "user") continue;
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) return m.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
    }
    return "";
  }

  async function handleApi(req, res, name, entry, jobId, query) {
    switch (name) {
      case "models":
        return send(res, 200, { object: "list", data: [{ id: MODEL, object: "model", created: MODEL_CREATED, owned_by: "twinly" }] });
      case "model":
        return send(res, 200, { id: MODEL, object: "model", created: MODEL_CREATED, owned_by: "twinly" });
      case "me": {
        // Like the real API: online means the heartbeat is fresh, which a
        // paused Mac still has (it just never picks jobs up).
        const online = config.mac !== "offline";
        const macRoutes = [["messages.send", "POST /v1/messages"], ["messages.read", "GET /v1/messages"],
          ["calls", "POST /v1/calls"], ["voice", "POST /v1/voice/speak"], ["tasks", "POST /v1/tasks"]];
        const cloudRoutes = [["chat", "POST /v1/chat/completions"], ["computer", "POST /v1/computer/next-action"],
          ["images", "POST /v1/images"]];
        const allowed = (list) => list.filter(([s]) => entry.scopes.includes(s)).map(([, r]) => r);
        return send(res, 200, {
          object: "me",
          key: { id: entry.id, name: entry.name, prefix: entry.prefix, scopes: entry.scopes },
          mac: {
            online,
            last_seen: online ? new Date().toISOString() : null,
            app_version: online ? "mock" : null,
            hint: online ? null : "Open Twinly on the key owner's Mac and sign in; messages, calls, voice and tasks need it running.",
          },
          can: { cloud: allowed(cloudRoutes), mac: online ? allowed(macRoutes) : [] },
        });
      }
      case "usage": {
        const used = state.charges.filter((c) => c.key_id === entry.id).reduce((a, c) => a + c.credits, 0);
        const d = new Date();
        return send(res, 200, {
          object: "usage",
          key: {
            id: entry.id, name: entry.name, prefix: entry.prefix, month: d.toISOString().slice(0, 7),
            requests: entry.requests, usage_usd: dollars(used), monthly_cap_usd: null, cap_percent_used: null, rpm_limit: config.rpm_limit,
          },
          plan: {
            tier: "free", prompts_per_day: 5, prompts_left_today: 5,
            daily_resets_at: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString(),
            extra_usage_usd: dollars(config.balance_credits),
          },
        });
      }
      case "job.get": {
        // ?wait=0..25 holds the answer until the job finishes or its status
        // changes from what it was when this request arrived. 200 once the job
        // is finished, 202 while it isn't, like the create endpoints.
        const j = ownJob(entry, jobId);
        const wait = parseWait(query, "job.get");
        sweep();
        const arrived = j.status;
        await waitFor(j, wait, () => TERMINAL.has(j.status) || j.status !== arrived);
        return send(res, TERMINAL.has(j.status) ? 200 : 202, publicJob(j));
      }
      case "job.cancel": {
        sweep();
        const j = ownJob(entry, jobId);
        // Only a job still waiting in line can be canceled from the API; once
        // it's on the owner's Mac, the owner stops it in Twinly.
        if (j.status === "queued") setStatus(j, "canceled", { error: { code: "canceled", message: "This job was canceled." } });
        if (j.status === "canceled") return send(res, 200, publicJob(j));
        if (j.status === "running" || j.status === "needs_approval") {
          throw new ApiError(409, "This job is already running on the owner's Mac, so it can't be canceled from the API. The owner can stop it in Twinly.",
            "job_running");
        }
        throw new ApiError(409, `This job already finished (${j.status}).`, "job_finished");
      }
      case "chat": {
        const body = await jsonBody(req, name);
        if (body.model !== undefined && body.model !== MODEL) {
          throw new ApiError(404, `The model '${String(body.model).slice(0, 64)}' does not exist. Use '${MODEL}'.`, "model_not_found", { param: "model" });
        }
        if (body.stream === true) throw new ApiError(400, "Streaming isn't supported yet. Leave stream unset or false.", "stream_not_supported", { param: "stream" });
        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          throw new ApiError(400, "messages must be a non-empty array.", "invalid_messages", { param: "messages" });
        }
        requireCredits(MOCK_CHAT_CREDITS, "this chat request");
        state.chatRequests.push(body);
        const last = lastUserText(body.messages);
        const content = config.chat_reply ??
          `Mock reply from twinly-core (no model was called). Your last message began: "${last.slice(0, 120)}"`;
        charge(entry, "chat", MOCK_CHAT_CREDITS);
        const promptTokens = Math.ceil(JSON.stringify(body.messages).length / 4);
        const completionTokens = Math.ceil(content.length / 4);
        return send(res, 200, {
          id: `chatcmpl-mock${state.chatRequests.length}`, object: "chat.completion", created: Math.floor(now() / 1000), model: MODEL,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        });
      }
      case "next-action": {
        const body = await jsonBody(req, name);
        if (!nonEmpty(body.goal) || body.goal.length > 2000) throw new ApiError(400, "goal is required (up to 2000 characters).", "invalid_goal", { param: "goal" });
        const shot = typeof body.screenshot === "string" ? body.screenshot.replace(/^data:image\/[a-z]+;base64,/, "") : "";
        if (!shot || !/^[A-Za-z0-9+/]+={0,2}$/.test(shot)) {
          throw new ApiError(400, "screenshot must be a base64 PNG, JPEG or WebP string.", "invalid_screenshot", { param: "screenshot" });
        }
        requireCredits(MOCK_NEXT_ACTION_CREDITS, "this computer request");
        charge(entry, "computer", MOCK_NEXT_ACTION_CREDITS);
        const n = Array.isArray(body.steps) ? body.steps.length : 0;
        const action = n === 0
          ? { type: "click", x: 500, y: 120, label: "Search box", reason: "Mock: click the search box first.", commits: false }
          : n === 1
            ? { type: "type", text: "twinly", reason: "Mock: type the search words.", commits: false }
            : { type: "done", text: "Mock: finished.", reason: "Mock: the goal looks done.", commits: false };
        return send(res, 200, { object: "computer.action", model: MODEL, coordinates: "0-1000", action, usage: { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230 } });
      }
      case "images": {
        const body = await jsonBody(req, name);
        const shape = body.shape ?? "square";
        if (!["square", "wide", "tall"].includes(shape)) throw bad('shape must be "square", "wide" or "tall".', "shape");
        if (!nonEmpty(body.prompt) || body.prompt.length > 2000) throw bad("Say what the image should show in prompt.", "prompt", "invalid_prompt");
        requireCredits(PRICES.images, "this image");
        charge(entry, "images", PRICES.images);
        return send(res, 200, { data: [{ b64_json: fixtures.jpg[shape].toString("base64"), mime: "image/jpeg" }] });
      }
      default:
        return createJob(req, res, entry, name, query);
    }
  }

  // ── /_mock: controls for tests and for poking at it by hand ──────────────

  function snapshot() {
    return {
      config: { ...config },
      balance_credits: config.balance_credits,
      reserved_credits: state.reserved,
      keys: [...state.keys.entries()].map(([key, k]) => ({ key, id: k.id, name: k.name, scopes: k.scopes, revoked: k.revoked, requests: k.requests })),
      jobs: [...state.jobs.values()].map((j) => ({ ...publicJob(j), payload: j.payload, key_id: j.keyEntry.id, claimed_at: j.claimed_at ? iso(j.claimed_at) : null })),
      outbox: state.outbox,
      calls: state.calls,
      chat_requests: state.chatRequests,
      webhooks: state.webhooks,
      bot_commands: state.botCommands,
      charges: state.charges,
      chats: state.chats.map((c) => ({ id: c.id, name: c.name, participants: c.participants, messages: c.messages.length })),
    };
  }

  async function handleControl(req, res, p) {
    const body = req.method === "POST" ? await jsonBody(req).catch(() => ({})) : {};
    const ok = (v = { ok: true }) => send(res, 200, v);
    switch (`${req.method} ${p}`) {
      case "GET /_mock/state":
        return ok(snapshot());
      case "POST /_mock/reset":
        reset(body);
        return ok({ ok: true, key: DEFAULT_KEY, webhook_secret: config.webhook_secret });
      case "POST /_mock/config": {
        const next = { ...body };
        if (isObject(next.run_ms)) next.run_ms = { ...config.run_ms, ...next.run_ms };
        Object.assign(config, next);
        if (config.mac === "online") pump();
        return ok({ ok: true, config });
      }
      case "POST /_mock/keys":
        return ok(addKey(body));
      case "POST /_mock/keys/revoke": {
        const k = state.keys.get(body.key);
        if (!k) return send(res, 404, { error: "no such key" });
        k.revoked = true;
        return ok();
      }
      case "POST /_mock/bot-command":
        return ok(await botCommand(body));
      case "POST /_mock/message-received": {
        const c = resolveChat(body.chat ?? "chat493021");
        const from = body.from ?? c.participants[0];
        const msg = { from, text: String(body.text ?? ""), at: iso() };
        c.messages.push(msg);
        const ticked = config.message_received_chats.some((x) => String(x).toLowerCase() === c.id || String(x).toLowerCase() === (c.name ?? "").toLowerCase());
        const record = ticked ? await deliverEvent("message.received", { chat: c.id, from, name: contactName(from), text: msg.text, at: msg.at }) : null;
        return ok({ emitted: Boolean(record), webhook: record });
      }
      case "POST /_mock/webhooks/test":
        return ok(await deliverEvent("webhook.test", { message: "This is a test event from Twinly." }) ?? { error: "no webhook_url set" });
    }
    const m = /^\/_mock\/jobs\/([^/]+)\/(decide|stop)$/.exec(p);
    if (m && req.method === "POST" && m[2] === "decide") return ok(decide(m[1], body.approve !== false));
    if (m && req.method === "POST") {
      // The owner pressing Stop on the job in Twinly: the Mac marks it canceled.
      const j = state.jobs.get(m[1]);
      if (!j || !["running", "needs_approval"].includes(j.status)) return send(res, 400, { error: "only a running or held job can be stopped" });
      setStatus(j, "canceled", { error: { code: "canceled", message: "The owner stopped this job in Twinly." } });
      return ok(publicJob(j));
    }
    return send(res, 404, { error: "unknown mock control" });
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url, "http://mock");
      const p = routePath(req.url);
      if (p.startsWith("/_mock/")) return await handleControl(req, res, p);
      if (req.headers.origin) {
        throw new ApiError(403, "The Twinly API can't be called from a web page: the page would hand your key to every visitor. Call it from your server.",
          "origin_not_allowed");
      }
      const found = match(p);
      if (!found) throw new ApiError(404, "Unknown endpoint. See /v1/models, /v1/chat/completions, /v1/computer/next-action, /v1/images, /v1/messages, /v1/calls, /v1/voice/speak, /v1/tasks, /v1/jobs/{id}, /v1/usage and /v1/me (start there: it says whether your key and your Mac are ready).", "not_found");
      const name = found.route[req.method];
      if (!name) {
        const allow = ["GET", "POST"].filter((m) => found.route[m]).join(", ");
        throw new ApiError(405, `Use ${allow} for ${p}.`, "method_not_allowed", { headers: { allow } });
      }
      if (name === "health") return send(res, 200, { ok: true });
      if (Number(req.headers["content-length"] ?? 0) > bodyCap(name)) throw tooLarge(name);
      const entry = authenticate(req);
      rateLimit(entry);
      requireScope(entry, name);
      return await handleApi(req, res, name, entry, found.jobId, url.searchParams);
    } catch (e) {
      if (e instanceof ApiError) return sendError(res, e);
      if (res.headersSent) return res.destroy();
      return send(res, req.url.startsWith("/_mock/") ? 400 : 500,
        { error: { message: e.message, type: "api_error", code: "mock_error", param: null } });
    }
  }

  reset();
  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  const sweeper = setInterval(sweep, 500);
  sweeper.unref();

  return {
    server,
    get config() {
      return config;
    },
    get state() {
      return snapshot();
    },
    reset,
    addKey,
    decide,
    botCommand,
    emit: deliverEvent,
    async listen(port = 4010, host = "127.0.0.1") {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      const url = `http://${host}:${server.address().port}`;
      return { url, base: `${url}/v1`, key: DEFAULT_KEY, webhook_secret: config.webhook_secret };
    },
    async close() {
      clearInterval(sweeper);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const HELP = `Twinly API v2 mock

  node server.js [options]

  --port <n>                 port (default 4010, 0 = any free port)
  --host <h>                 host (default 127.0.0.1)
  --offline                  the Mac is offline: Mac endpoints answer 409 twinly_offline
  --paused                   the Mac's heartbeat is fresh but it never picks jobs up (queue_timeout after 30 min)
  --balance <credits>        starting usage balance (default 200 = a $20 voucher; 0 = 402s)
  --hold <kinds>             comma list of job kinds held as needs_approval (e.g. messages.send)
  --webhook-url <url>        where the fake Mac POSTs signed events
  --webhook-secret <s>       signing secret (default: a random whsec_mock_...)
  --bot-commands <list>      registered bot commands, e.g. weather,price
  --allow-local-attachments  accept and fetch http://127.0.0.1 attachment URLs
  --fast                     short job times and webhook retries (what the tests use)
  --help

Key: ${DEFAULT_KEY}
Controls: GET /_mock/state, POST /_mock/config, /_mock/reset, /_mock/bot-command,
          /_mock/jobs/<id>/decide, /_mock/jobs/<id>/stop, /_mock/keys, /_mock/message-received, /_mock/webhooks/test
`;

function parseArgs(argv) {
  const out = { config: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    switch (a) {
      case "--help": out.help = true; break;
      case "--port": out.port = Number(val()); break;
      case "--host": out.host = val(); break;
      case "--offline": out.config.mac = "offline"; break;
      case "--paused": out.config.mac = "paused"; break;
      case "--balance": out.config.balance_credits = Number(val()); break;
      case "--hold": out.config.hold = val().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--webhook-url": out.config.webhook_url = val(); break;
      case "--webhook-secret": out.config.webhook_secret = val(); break;
      case "--bot-commands": out.config.bot_commands = val().split(",").map((s) => s.trim().toLowerCase()).filter(Boolean); break;
      case "--allow-local-attachments": out.config.allow_local_attachments = true; break;
      case "--fast":
        Object.assign(out.config, {
          claim_ms: 20,
          run_ms: { "messages.send": 60, "messages.read": 40, "voice.speak": 80, "calls.place": 300, "tasks.run": 250 },
          retry_delays_ms: [50, 100, 150],
        });
        break;
      default:
        throw new Error(`Unknown option ${a}. Try --help.`);
    }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const mock = createMockApi({ config: args.config });
  const info = await mock.listen(args.port ?? 4010, args.host ?? "127.0.0.1");
  process.stdout.write(
    `Twinly mock API on ${info.base}\n` +
    `  key:            ${info.key}\n` +
    `  webhook secret: ${info.webhook_secret}\n` +
    `  Mac:            ${mock.config.mac}, balance ${mock.config.balance_credits} credits\n` +
    `MOCK_API_READY ${JSON.stringify(info)}\n`,
  );
  const stop = () => mock.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
