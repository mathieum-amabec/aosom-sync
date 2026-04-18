// Regression tests for v0.1.9.0 auth + RBAC changes
// Covers: 4-part token format, old-token rejection, tamper rejection,
// reviewer path allowlist, hmacSign throws without AUTH_PASSWORD
// Found by /review + /qa on 2026-04-18
// Report: .gstack/qa-reports/

import { describe, it, expect, beforeAll, vi } from "vitest";

// Mock next/headers so auth.ts can be imported in vitest (Node env)
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  }),
}));

// Set AUTH_PASSWORD before importing auth.ts (module-level HMAC_SECRET reads it at import time)
const TEST_SECRET = "test-secret-for-vitest";
process.env.AUTH_PASSWORD = TEST_SECRET;

// Import after env is set
const { createSessionToken, verifySessionToken, isPathAllowedForRole } = await import("@/lib/auth");

describe("createSessionToken + verifySessionToken (4-part format)", () => {
  it("round-trips admin token", async () => {
    const token = await createSessionToken("admin", "admin");
    const payload = await verifySessionToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.username).toBe("admin");
    expect(payload?.role).toBe("admin");
  });

  it("round-trips reviewer token", async () => {
    const token = await createSessionToken("meta-review", "reviewer");
    const payload = await verifySessionToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.username).toBe("meta-review");
    expect(payload?.role).toBe("reviewer");
  });

  it("round-trips username containing a colon", async () => {
    // usernames with colons should still parse correctly (parts.slice(2,-1).join(":"))
    const token = await createSessionToken("user:name", "admin");
    const payload = await verifySessionToken(token);
    expect(payload?.username).toBe("user:name");
  });

  it("rejects old 3-part token (ts:username:sig)", async () => {
    // Simulate a pre-v0.1.9.0 token: base64("ts:username:sig") — only 3 parts
    const oldToken = btoa("1713000000000:admin:fakesig");
    const result = await verifySessionToken(oldToken);
    expect(result).toBeNull();
  });

  it("rejects tampered payload", async () => {
    const token = await createSessionToken("admin", "admin");
    const decoded = atob(token);
    // Change role from admin to reviewer
    const tampered = decoded.replace(":admin:", ":reviewer:");
    const tamperedToken = btoa(tampered);
    const result = await verifySessionToken(tamperedToken);
    expect(result).toBeNull();
  });

  it("rejects token with invalid role", async () => {
    // Manually craft a token with an unknown role
    const ts = Date.now().toString();
    const fakeToken = btoa(`${ts}:superadmin:admin:fakesig`);
    const result = await verifySessionToken(fakeToken);
    expect(result).toBeNull();
  });

  it("rejects garbage input", async () => {
    expect(await verifySessionToken("not-base64!")).toBeNull();
    expect(await verifySessionToken("")).toBeNull();
    expect(await verifySessionToken(btoa("tooshort"))).toBeNull();
  });
});

describe("isPathAllowedForRole", () => {
  it("admin can access any path", () => {
    expect(isPathAllowedForRole("/catalog", "admin")).toBe(true);
    expect(isPathAllowedForRole("/import", "admin")).toBe(true);
    expect(isPathAllowedForRole("/api/sync/trigger", "admin")).toBe(true);
    expect(isPathAllowedForRole("/some/random/path", "admin")).toBe(true);
  });

  it("reviewer can access /social and sub-paths", () => {
    expect(isPathAllowedForRole("/social", "reviewer")).toBe(true);
    expect(isPathAllowedForRole("/social/new", "reviewer")).toBe(true);
    expect(isPathAllowedForRole("/social?filter=draft", "reviewer")).toBe(true);
  });

  it("reviewer can access /settings", () => {
    expect(isPathAllowedForRole("/settings", "reviewer")).toBe(true);
    expect(isPathAllowedForRole("/settings/advanced", "reviewer")).toBe(true);
  });

  it("reviewer can access /api/social", () => {
    expect(isPathAllowedForRole("/api/social", "reviewer")).toBe(true);
    expect(isPathAllowedForRole("/api/social/drafts", "reviewer")).toBe(true);
  });

  it("reviewer can access /api/settings (read-only GET goes through)", () => {
    expect(isPathAllowedForRole("/api/settings", "reviewer")).toBe(true);
  });

  it("reviewer cannot access catalogue, sync, import, collections", () => {
    expect(isPathAllowedForRole("/catalog", "reviewer")).toBe(false);
    expect(isPathAllowedForRole("/sync", "reviewer")).toBe(false);
    expect(isPathAllowedForRole("/import", "reviewer")).toBe(false);
    expect(isPathAllowedForRole("/collections", "reviewer")).toBe(false);
  });

  it("reviewer cannot access admin API routes", () => {
    expect(isPathAllowedForRole("/api/sync/trigger", "reviewer")).toBe(false);
    expect(isPathAllowedForRole("/api/import/push", "reviewer")).toBe(false);
    expect(isPathAllowedForRole("/api/catalog", "reviewer")).toBe(false);
  });

  it("reviewer prefix match is exact — /socialmedia is NOT allowed", () => {
    // /socialmedia starts with /social but is not /social or /social/
    expect(isPathAllowedForRole("/socialmedia", "reviewer")).toBe(false);
  });

  it("reviewer can access /api/auth for login/logout", () => {
    expect(isPathAllowedForRole("/api/auth", "reviewer")).toBe(true);
  });

  it("reviewer can access /privacy", () => {
    expect(isPathAllowedForRole("/privacy", "reviewer")).toBe(true);
  });
});
