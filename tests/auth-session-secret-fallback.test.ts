// Companion to auth-session-secret.test.ts: proves a whitespace-only SESSION_SECRET
// (a fat-fingered env value) is trimmed to empty and falls back to AUTH_PASSWORD,
// rather than silently signing tokens with " ". Separate file because auth.ts reads
// its signing key once at import time.

import { describe, it, expect } from "vitest";

const AUTH_PASSWORD = "login-password-fallback";
process.env.SESSION_SECRET = "   "; // whitespace-only → trimmed to "" → falls back
process.env.AUTH_PASSWORD = AUTH_PASSWORD;

const { createSessionToken, verifySessionToken } = await import("@/lib/auth");

async function signWith(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return btoa(`${payload}:${hex}`);
}

describe("whitespace SESSION_SECRET trims to empty and falls back (Finding 2)", () => {
  it("signs with AUTH_PASSWORD, not the whitespace value", async () => {
    const token = await createSessionToken("admin", "admin");
    expect(await verifySessionToken(token)).toEqual({ username: "admin", role: "admin" });
    // A token forged with the literal whitespace key must NOT verify.
    const bogus = await signWith("   ", `${Date.now()}:admin:admin`);
    expect(await verifySessionToken(bogus)).toBeNull();
  });
});
