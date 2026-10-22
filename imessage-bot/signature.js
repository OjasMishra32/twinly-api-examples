// Checks that a webhook really came from your Twinly.
//
// Twinly signs every webhook with your signing secret:
//   X-Twinly-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
// Recompute it over the RAW body bytes (before JSON.parse), compare in
// constant time, and refuse old timestamps so a captured request can't be
// replayed later.

import crypto from "node:crypto";

export function verifySignature(secret, header, rawBody, { toleranceSeconds = 300, nowMs = Date.now() } = {}) {
  if (!secret || typeof header !== "string") return false;
  const parts = {};
  for (const piece of header.split(",")) {
    const at = piece.indexOf("=");
    if (at > 0) parts[piece.slice(0, at).trim()] = piece.slice(at + 1).trim();
  }
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? "")) return false;
  if (Math.abs(nowMs / 1000 - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(parts.v1, "hex"));
}
