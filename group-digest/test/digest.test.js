// Runs digest.js against the local mock API and checks what you'd see.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { startMock } from "../../mock-api/testkit.js";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "digest.js");
const DIGEST = "- Demo at 4pm, 3 minute pitch\n- Sam is getting pizza\n- Cut the architecture slide";

let mock;
before(async () => (mock = await startMock()));
after(() => mock.stop());
beforeEach(() => mock.control("reset", {}).then(() => mock.config({ claim_ms: 20, chat_reply: DIGEST })));

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: os.tmpdir(),
      env: { ...process.env, TWINLY_API_BASE: mock.base, TWINLY_API_KEY: mock.key, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("reads the chat and prints the digest", async () => {
  const r = await run(["--chat", "Hack Squad"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Digest of Hack Squad \(last 8 messages\)/);
  assert.ok(r.stdout.includes(DIGEST));
  const s = await mock.state();
  assert.deepEqual(s.jobs.map((j) => [j.kind, j.payload.chat, j.payload.limit]), [["messages.read", "Hack Squad", 30]]);
  // The model saw every message, with names instead of numbers.
  const sent = s.chat_requests[0].messages.at(-1).content;
  for (const line of ["Sam Lee: ok team, demo is at 4pm sharp", "Me: then we cut the architecture slide", "Diego Ortiz: agreed. I'll rehearse the demo at 3"]) {
    assert.ok(sent.includes(line), `missing: ${line}`);
  }
  assert.equal(s.outbox.length, 0, "nothing is sent without --post");
});

test("--limit reads fewer messages", async () => {
  const r = await run(["--chat", "chat493021", "--limit", "2"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /last 2 messages/);
  assert.ok(!(await mock.state()).chat_requests[0].messages.at(-1).content.includes("demo is at 4pm"));
});

test("--post sends the digest into the same chat", async () => {
  const r = await run(["--chat", "Hack Squad", "--post"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Posted to Hack Squad \(delivered\)/);
  const { outbox } = await mock.state();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].chat, "chat493021");
  assert.equal(outbox[0].text, `Catch-up:\n${DIGEST}`);
});

test("--with reads your chat with one person", async () => {
  const r = await run(["--with", "Mom"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Digest of your chat with Mom \(last 2 messages\)/);
  const s = await mock.state();
  assert.deepEqual(s.jobs[0].payload, { with: "Mom", limit: 30 });
  assert.ok(s.chat_requests[0].messages.at(-1).content.includes("Mom: Are you eating enough at this hackathon?"));
  const both = await run(["--chat", "Hack Squad", "--with", "Mom"]);
  assert.equal(both.code, 2);
});

test("a key without messages.read is told which scope is missing", async () => {
  const { key } = await mock.control("keys", { scopes: ["chat"] });
  const r = await run(["--chat", "Hack Squad"], { TWINLY_API_KEY: key });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /'messages\.read' scope/);
});

test("an unknown chat and an offline Mac both explain themselves", async () => {
  let r = await run(["--chat", "Not A Chat"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Couldn't find a chat matching "Not A Chat"/);
  await mock.config({ mac: "offline" });
  r = await run(["--chat", "Hack Squad"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Your Twinly isn't running/);
});
