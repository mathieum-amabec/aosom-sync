// CSO Finding 3: SESSION_SECRET is REQUIRED — the AUTH_PASSWORD fallback is removed.
// A whitespace-only SESSION_SECRET trims to empty and is treated as unset, so session
// signing/verification FAILS CLOSED rather than silently signing with the low-entropy
// AUTH_PASSWORD. Separate file because auth.ts reads its signing key once at import.

import { describe, it, expect } from "vitest";

process.env.SESSION_SECRET = "   "; // whitespace-only → trimmed to "" → treated as unset
process.env.AUTH_PASSWORD = "login-password-not-a-signing-fallback";

const { createSessionToken, verifySessionToken } = await import("@/lib/auth");

describe("whitespace SESSION_SECRET fails closed — no AUTH_PASSWORD fallback (Finding 3)", () => {
  it("refuses to SIGN a session when SESSION_SECRET is effectively unset", async () => {
    await expect(createSessionToken("admin", "admin")).rejects.toThrow(/SESSION_SECRET/);
  });

  it("verifies to null (no session) — never falls back to AUTH_PASSWORD", async () => {
    // A fresh, well-formed token still can't be verified without a real secret:
    // hmacSign throws inside verify and the guard returns null (access denied).
    const freshToken = btoa(`${Date.now()}:admin:admin:deadbeef`);
    expect(await verifySessionToken(freshToken)).toBeNull();
  });
});
