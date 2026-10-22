#!/usr/bin/env node
// Give your Twinly a task, wait for it, print the answer and save any files.
//
//   node task.js "Find the 3 cheapest flights from GNV to SFO next Friday"
//   node task.js "Screenshot the GatorHack schedule page" --out ./out

import fs from "node:fs";
import path from "node:path";
import { explain, loadEnv, twinly, waitForJob } from "./twinly.js";

loadEnv();

const args = process.argv.slice(2);
let outDir = "out";
const words = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") outDir = args[++i];
  else words.push(args[i]);
}
const prompt = words.join(" ").trim();
if (!prompt) {
  console.error('Usage: node task.js "what you want done" [--out ./out]');
  process.exit(2);
}

const STATUS = {
  running: "Your Twinly is working on it...",
  needs_approval: "Twinly is waiting for you to approve a step in the app on your Mac.",
};

let job;
// Ctrl-C cancels a task that hasn't started yet. Once it's running on your
// Mac, only you can stop it there (the API answers 409 job_running).
process.on("SIGINT", async () => {
  let note = "Canceled.";
  if (job) {
    await twinly("POST", `/jobs/${job.id}/cancel`).catch((err) => {
      note = err.code === "job_running"
        ? "Stopped waiting. The task is already running on your Mac: stop it in Twinly if you want it to stop."
        : `Stopped waiting (${err.message})`;
    });
  }
  console.error(`\n${note}`);
  process.exit(130);
});

try {
  job = await twinly("POST", "/tasks", { prompt });
  console.log(`Sent to your Twinly (job ${job.id}).`);
  if (STATUS[job.status]) console.log(STATUS[job.status]);
  job = await waitForJob(job, (j) => STATUS[j.status] && console.log(STATUS[j.status]));
} catch (err) {
  console.error(`Error: ${explain(err)}`);
  process.exit(1);
}

if (job.status !== "done") {
  console.error(`The task ${job.status}: ${job.error ? explain(job.error) : "no reason given"}`);
  process.exit(1);
}

console.log(`\n${job.result.answer}\n`);
const files = job.result.files ?? [];
if (files.length) fs.mkdirSync(outDir, { recursive: true });
for (const file of files) {
  // path.basename keeps a file name like "../../x" inside your out folder.
  const name = path.basename(file.name || "file") || "file";
  const where = path.join(outDir, name);
  const bytes = Buffer.from(file.b64, "base64");
  fs.writeFileSync(where, bytes);
  console.log(`Saved ${where} (${file.mime}, ${bytes.length} bytes)`);
}
