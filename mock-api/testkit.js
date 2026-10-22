// Starts the mock API in a child process for a test, and gives the test its
// controls. Used by every Node example's test (Python has testkit.py).
//
//   const mock = await startMock({ config: { hold: ["messages.send"] } });
//   ... run your code with TWINLY_API_BASE=mock.base, TWINLY_API_KEY=mock.key
//   const state = await mock.state();
//   await mock.stop();

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.js");

export async function startMock({ args = [], config = null } = {}) {
  const child = spawn(process.execPath, [SERVER, "--port", "0", "--fast", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const info = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`mock API didn't start: ${stderr}`)), 10_000);
    child.stdout.on("data", (d) => {
      out += d;
      const line = out.split("\n").find((l) => l.startsWith("MOCK_API_READY "));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line.slice("MOCK_API_READY ".length)));
      }
    });
    child.on("exit", (code) => reject(new Error(`mock API exited (${code}): ${stderr}`)));
  });

  async function control(route, body) {
    const res = await fetch(`${info.url}/_mock/${route.replace(/^\//, "")}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`mock control ${route} failed: ${JSON.stringify(json)}`);
    return json;
  }

  if (config) await control("config", config);

  return {
    ...info,
    control,
    state: () => control("state"),
    config: (c) => control("config", c),
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await exited;
    },
  };
}

/** Polls fn() until it returns something truthy (or throws after timeoutMs). */
export async function eventually(fn, { timeoutMs = 5000, everyMs = 50 } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timed out waiting (last value: ${JSON.stringify(last)})`);
}
