// Regression: P2-4 (admin guard on paid routes) + P3-7 (shared cron-auth helper)
// Found by /qa on 2026-06-28 during the /cso security-hardening branch.
// Report: docs/SECURITY-BACKLOG.md (Audit 2026-06-28)
//
// Covers the two security primitives this branch introduced:
//   - isAdmin()       — gates paid Anthropic routes (import/generate, blog/generate)
//   - verifyCronSecret() — the constant-time Bearer check extracted from 16 routes
//
// Mirrors the next/headers + AUTH_PASSWORD setup from auth-rbac.test.ts, but with
// a *mutable* cookie holder so each role can be exercised through the real
// getSession → verifySessionToken path (no stubbing of the auth internals).

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Mutable session token the mocked cookie store returns. Each test sets it.
let currentToken: string | undefined;

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: () => (currentToken ? { value: currentToken } : undefined),
    set: () => {},
    delete: () => {},
  }),
}));

// HMAC_SECRET is read at import time from AUTH_PASSWORD — set before importing auth.
process.env.AUTH_PASSWORD = "test-secret-for-vitest";

const { createSessionToken, isAdmin, getSessionRole } = await import("@/lib/auth");
const { verifyCronSecret } = await import("@/lib/cron-auth");

describe("isAdmin (P2-4 paid-route gate)", () => {
  beforeEach(() => {
    currentToken = undefined;
  });

  it("returns true for an admin session", async () => {
    currentToken = await createSessionToken("admin", "admin");
    expect(await isAdmin()).toBe(true);
  });

  it("returns false for a reviewer session (cannot trigger paid generation)", async () => {
    currentToken = await createSessionToken("meta-review", "reviewer");
    // sanity: the session IS valid, it's just not admin
    expect(await getSessionRole()).toBe("reviewer");
    expect(await isAdmin()).toBe(false);
  });

  it("returns false when there is no session", async () => {
    currentToken = undefined;
    expect(await isAdmin()).toBe(false);
  });

  it("returns false for a tampered token (admin→reviewer flip is rejected)", async () => {
    const token = await createSessionToken("admin", "admin");
    currentToken = btoa(atob(token).replace(":admin:", ":reviewer:"));
    // tampered signature → verifySessionToken returns null → not admin
    expect(await isAdmin()).toBe(false);
  });
});

describe("verifyCronSecret (P3-7 shared helper)", () => {
  const ORIGINAL = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
  });

  // restore after the suite so we don't leak env into other files
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ORIGINAL;
  });

  it("accepts the correct Bearer token", () => {
    expect(verifyCronSecret("Bearer test-cron-secret")).toBe(true);
  });

  it("rejects a wrong token of the same length (constant-time path)", () => {
    expect(verifyCronSecret("Bearer test-cron-WRONGX")).toBe(false);
  });

  it("rejects a token of a different length without throwing", () => {
    expect(verifyCronSecret("Bearer short")).toBe(false);
    expect(verifyCronSecret("Bearer test-cron-secret-with-extra")).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyCronSecret(null)).toBe(false);
    expect(verifyCronSecret("")).toBe(false);
  });

  it("fails closed (401, not 500) when CRON_SECRET is unset", () => {
    delete process.env.CRON_SECRET;
    // env.cronSecret throws → helper catches → false, never propagates a 500
    expect(verifyCronSecret("Bearer anything")).toBe(false);
  });
});
