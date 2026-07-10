// Regression test for the SESSION_SECRET fix (CSO-1): the session-token signing
// key must be SESSION_SECRET, DISTINCT from the human login password AUTH_PASSWORD.
// Proves a token signed with AUTH_PASSWORD does NOT verify once SESSION_SECRET is set,
// so a recovered/known AUTH_PASSWORD can no longer forge sessions.

import { describe, it, expect } from "vitest";

// auth.ts reads its signing key at module-import time, so both env vars must be set
// BEFORE the dynamic import. SESSION_SECRET and AUTH_PASSWORD are deliberately different.
const SESSION_SECRET = "dedicated-session-secret-0123456789abcdef";
const AUTH_PASSWORD = "weak-login-password";
process.env.SESSION_SECRET = SESSION_SECRET;
process.env.AUTH_PASSWORD = AUTH_PASSWORD;

const { createSessionToken, verifySessionToken } = await import("@/lib/auth");

/** Re-implement the token wire format, signing with an arbitrary key (mirrors auth.ts). */
async function signWith(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return btoa(`${payload}:${hex}`);
}

describe("session signing uses SESSION_SECRET, not AUTH_PASSWORD (CSO-1)", () => {
  it("round-trips a token signed with SESSION_SECRET", async () => {
    const token = await createSessionToken("admin", "admin");
    const payload = await verifySessionToken(token);
    expect(payload).toEqual({ username: "admin", role: "admin" });
  });

  it("REJECTS a token forged with AUTH_PASSWORD (the old weak key)", async () => {
    // An attacker who recovered AUTH_PASSWORD tries to forge an admin session.
    const forged = await signWith(AUTH_PASSWORD, `${Date.now()}:admin:admin`);
    expect(await verifySessionToken(forged)).toBeNull();
  });

  it("ACCEPTS a token forged with SESSION_SECRET (confirms that is the real key)", async () => {
    const good = await signWith(SESSION_SECRET, `${Date.now()}:reviewer:meta-review`);
    expect(await verifySessionToken(good)).toEqual({ username: "meta-review", role: "reviewer" });
  });
});
