// A tiny Twinly API client. Node 20+ built-ins only.
//
//   loadEnv()                         read .env next to this file (never overrides real env vars)
//   await twinly("POST", "/tasks", { prompt })   one API call; throws TwinlyError on an error
//   await waitForJob(job, onUpdate)   wait for a job to be done, failed, canceled or expired

import fs from "node:fs";

const DEFAULT_BASE = "https://advktwnedlgnhswpxokg.supabase.co/functions/v1/twinly-api/v1";
export const FINISHED = new Set(["done", "failed", "canceled", "expired"]);

export class TwinlyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function loadEnv(file = new URL("./.env", import.meta.url)) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function twinly(method, path, body) {
  const key = process.env.TWINLY_API_KEY;
  if (!key) {
    throw new TwinlyError(0, "missing_api_key", "Set TWINLY_API_KEY in .env (Twinly ▸ Settings ▸ Developer API ▸ Create a key).");
  }
  const base = (process.env.TWINLY_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new TwinlyError(0, "network", `Couldn't reach ${base} (${e.cause?.code ?? e.message}).`);
    }
    const data = await res.json().catch(() => ({}));
    const code = data.error?.code;
    // Too fast, or Twinly busy for a moment: wait as told and try again.
    if (attempt < 3 && (res.status === 503 || (res.status === 429 && code === "rate_limited"))) {
      await sleep(Number(res.headers.get("retry-after") ?? 2) * 1000);
      continue;
    }
    if (!res.ok) throw new TwinlyError(res.status, code ?? "http_error", data.error?.message ?? `HTTP ${res.status}`);
    return data; // 200, or 202 for a job that isn't finished yet
  }
}

export async function waitForJob(job, onUpdate = () => {}) {
  while (!FINISHED.has(job.status)) {
    // The server holds this for up to 25 s and answers as soon as the job
    // finishes or its status changes, so this is one request per change.
    const asked = Date.now();
    const next = await twinly("GET", `/jobs/${job.id}?wait=25`);
    if (next.status !== job.status) onUpdate(next);
    else if (Date.now() - asked < 1000) await sleep(1000); // never hammer a server that answers at once
    job = next;
  }
  return job;
}

/** One line a person can act on, for an API error or a job that didn't finish. */
export function explain(err) {
  const hints = {
    twinly_offline: "Open Twinly on your Mac, sign in, and keep Settings ▸ Developer API on.",
    insufficient_usage: "Redeem a code in Twinly ▸ Settings ▸ Developer API, or add extra usage on Account.",
    missing_api_key: "",
    invalid_api_key: "Check TWINLY_API_KEY in .env.",
    scope_missing: "",
  };
  const hint = hints[err.code];
  return hint ? `${err.message} ${hint}` : err.message;
}
