import { describe, it, expect } from "vitest";
import { verifySessionToken, signSessionToken } from "@/lib/post-purchase/session-token";

const SECRET = "shpss_test_secret";
const OPTS = { secret: SECRET, clientId: "client-123", shopDomain: "27u5y2-kp.myshopify.com", nowSec: 1_800_000_000 };
const base = { dest: "27u5y2-kp.myshopify.com", aud: "client-123", exp: 1_800_000_300, nbf: 1_799_999_990, iat: 1_799_999_990, jti: "x" };

describe("verifySessionToken", () => {
  it("accepts a token signed with the app secret for our store", () => {
    const r = verifySessionToken(signSessionToken(base, SECRET), OPTS);
    expect(r.ok).toBe(true);
  });
  it("accepts dest given as a URL", () => {
    expect(verifySessionToken(signSessionToken({ ...base, dest: "https://27u5y2-kp.myshopify.com" }, SECRET), OPTS).ok).toBe(true);
  });
  it("rejects a bad signature", () => {
    expect(verifySessionToken(signSessionToken(base, "other-secret"), OPTS)).toEqual({ ok: false, reason: "signature" });
  });
  it("rejects a tampered payload", () => {
    const [h, , s] = signSessionToken(base, SECRET).split(".");
    const p = Buffer.from(JSON.stringify({ ...base, dest: "evil.myshopify.com" })).toString("base64url");
    expect(verifySessionToken(`${h}.${p}.${s}`, OPTS)).toEqual({ ok: false, reason: "signature" });
  });
  it("rejects another app (aud) or another store (dest)", () => {
    expect(verifySessionToken(signSessionToken({ ...base, aud: "other" }, SECRET), OPTS)).toEqual({ ok: false, reason: "aud" });
    expect(verifySessionToken(signSessionToken({ ...base, dest: "other.myshopify.com" }, SECRET), OPTS)).toEqual({ ok: false, reason: "dest" });
  });
  it("rejects expired and not-yet-valid tokens", () => {
    expect(verifySessionToken(signSessionToken({ ...base, exp: 1_799_999_000 }, SECRET), OPTS)).toEqual({ ok: false, reason: "expired" });
    expect(verifySessionToken(signSessionToken({ ...base, nbf: 1_800_000_500 }, SECRET), OPTS)).toEqual({ ok: false, reason: "not-yet-valid" });
  });
  it("rejects missing, malformed and alg-none tokens", () => {
    expect(verifySessionToken(null, OPTS).ok).toBe(false);
    expect(verifySessionToken("abc", OPTS).ok).toBe(false);
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(base)).toString("base64url")}.`;
    expect(verifySessionToken(none, OPTS)).toEqual({ ok: false, reason: "alg" });
  });
});
