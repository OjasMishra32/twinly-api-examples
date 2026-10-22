// Runs task.js against the local mock API and checks what you'd see.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { eventually, startMock } from "../../mock-api/testkit.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "task.js");
const FIXTURE_PNG = fs.readFileSync(path.join(HERE, "..", "..", "mock-api", "fixtures", "result.png"));

let mock;
before(async () => (mock = await startMock()));
after(() => mock.stop());
beforeEach(() => mock.control("reset", {}).then(() => mock.config({ claim_ms: 20, run_ms: { "tasks.run": 250 } })));

function start(args, env = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    cwd: os.tmpdir(),
    env: { ...process.env, TWINLY_API_BASE: mock.base, TWINLY_API_KEY: mock.key, ...env },
  });
  const out = { stdout: "", stderr: "", child };
  child.stdout.on("data", (d) => (out.stdout += d));
  child.stderr.on("data", (d) => (out.stderr += d));
  out.done = new Promise((resolve) => child.on("exit", (code) => resolve({ code, ...out })));
  return out;
}

const run = (args, env) => start(args, env).done;

/** Starts task.js, waits until it reports the held step, then decides it like the owner would. */
async function runAndDecide(args, approve) {
  const live = start(args);
  await eventually(() => /waiting for you to approve/.test(live.stdout));
  const job = (await mock.state()).jobs.find((j) => j.status === "needs_approval");
  await mock.control(`jobs/${job.id}/decide`, { approve });
  return live.done;
}

test("prints the answer and saves the file the task made", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "twinly-task-"));
  const r = await run(["Take a screenshot of the GatorHack schedule", "--out", out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Sent to your Twinly \(job [0-9a-f-]{36}\)/);
  assert.match(r.stdout, /working on it/);
  assert.match(r.stdout, /Mock answer: I worked on "Take a screenshot of the GatorHack schedule"/);
  assert.match(r.stdout, /Saved .*result\.png \(image\/png, 145 bytes\)/);
  assert.deepEqual(fs.readFileSync(path.join(out, "result.png")), FIXTURE_PNG);
  const s = await mock.state();
  assert.equal(s.jobs.length, 1);
  assert.equal(s.jobs[0].kind, "tasks.run");
  assert.equal(s.jobs[0].payload.prompt, "Take a screenshot of the GatorHack schedule");
  assert.deepEqual(s.charges.map((c) => c.kind), ["tasks.run"]);
  // One POST, then one long-poll per status change (queued -> running -> done): no polling.
  assert.equal(s.keys[0].requests, 3);
});

test("waits through an approval the owner gives in the app", async () => {
  await mock.config({ hold: ["tasks.run"] });
  const r = await runAndDecide(["Book the study room for 3pm"], true);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /waiting for you to approve a step/);
  assert.match(r.stdout, /Book the study room for 3pm/);
});

test("says so when the Mac is off", async () => {
  await mock.config({ mac: "offline" });
  const r = await run(["anything"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Your Twinly isn't running/);
  assert.equal((await mock.state()).jobs.length, 0);
});

test("says so when the account is out of usage", async () => {
  await mock.config({ balance_credits: 1 });
  const r = await run(["anything"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Redeem a code/);
});

test("a failed task exits 1 with the reason", async () => {
  await mock.config({ hold: ["tasks.run"] });
  const r = await runAndDecide(["Delete my calendar"], false);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /The task failed: The owner declined this/);
});

test("Ctrl-C cancels a task still in line, and says so once it's running", async () => {
  await mock.config({ mac: "paused" });
  let live = start(["Wait in line"]);
  await eventually(async () => (await mock.state()).jobs.length === 1);
  live.child.kill("SIGINT");
  let r = await live.done;
  assert.equal(r.code, 130);
  assert.match(r.stderr, /Canceled\./);
  assert.equal((await mock.state()).jobs[0].status, "canceled");

  await mock.control("reset", {});
  await mock.config({ claim_ms: 20, hold: ["tasks.run"] });
  live = start(["Needs a yes"]);
  await eventually(() => /waiting for you to approve/.test(live.stdout));
  live.child.kill("SIGINT");
  r = await live.done;
  assert.equal(r.code, 130);
  assert.match(r.stderr, /already running on your Mac: stop it in Twinly/);
  assert.equal((await mock.state()).jobs[0].status, "needs_approval");
});

test("no key, no prompt", async () => {
  let r = await run(["hi"], { TWINLY_API_KEY: "" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Set TWINLY_API_KEY/);
  r = await run([]);
  assert.equal(r.code, 2);
});

test("503 job_unverified is never retried: the task may still run", async () => {
  await mock.config({ unverify_jobs: 1 });
  const r = await run(["Book the table"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /couldn't confirm this job was created/);
  assert.match(r.stderr, /Don't send it again yet/);
  const s = await mock.state();
  assert.equal(s.jobs.length, 1, "one POST, no retry");
  assert.equal(s.keys[0].requests, 1);
});
