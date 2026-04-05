import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";

const SESSION_MAX_AGE_MS = 60 * 60 * 24 * 7 * 1000; // 7 days

function makeToken(ts: string, password: string): string {
  const secret = crypto.createHash("sha256").update(password).digest("hex");
  const hmac = crypto.createHmac("sha256", secret).update(ts).digest("hex");
  return Buffer.from(`${ts}:${hmac}`).toString("base64");
}

describe("auth token", () => {
  const TEST_PASSWORD = "test-secure-password";

  beforeEach(() => {
    vi.resetModules();
    process.env.AUTH_PASSWORD = TEST_PASSWORD;
  });

  afterEach(() => {
    delete process.env.AUTH_PASSWORD;
  });

  it("createToken produces a valid token that verifyToken accepts", async () => {
    const { createToken, verifyToken } = await import("@/lib/auth");
    const token = createToken();
    expect(verifyToken(token)).toBe(true);
  });

  it("verifyToken rejects a token with tampered HMAC", async () => {
    const { createToken, verifyToken } = await import("@/lib/auth");
    const good = Buffer.from(createToken(), "base64").toString();
    const ts = good.slice(0, good.indexOf(":"));
    const tampered = Buffer.from(`${ts}:deadbeef0000`).toString("base64");
    expect(verifyToken(tampered)).toBe(false);
  });

  it("verifyToken rejects a token with no colon separator", async () => {
    const { verifyToken } = await import("@/lib/auth");
    const token = Buffer.from("notokencolon").toString("base64");
    expect(verifyToken(token)).toBe(false);
  });

  it("verifyToken rejects an expired token (age >= 7 days)", async () => {
    const { verifyToken } = await import("@/lib/auth");
    const oldTs = (Date.now() - SESSION_MAX_AGE_MS - 1000).toString();
    const token = makeToken(oldTs, TEST_PASSWORD);
    expect(verifyToken(token)).toBe(false);
  });

  it("verifyToken rejects a future timestamp (age < 0)", async () => {
    const { verifyToken } = await import("@/lib/auth");
    const futureTs = (Date.now() + 60_000).toString();
    const token = makeToken(futureTs, TEST_PASSWORD);
    expect(verifyToken(token)).toBe(false);
  });

  it("verifyToken rejects garbage base64", async () => {
    const { verifyToken } = await import("@/lib/auth");
    expect(verifyToken("not-valid-base64!!!")).toBe(false);
  });

  it("verifyToken rejects empty string", async () => {
    const { verifyToken } = await import("@/lib/auth");
    expect(verifyToken("")).toBe(false);
  });

  it("throws when AUTH_PASSWORD is not set", async () => {
    delete process.env.AUTH_PASSWORD;
    const { createToken } = await import("@/lib/auth");
    expect(() => createToken()).toThrow("AUTH_PASSWORD");
  });
});
