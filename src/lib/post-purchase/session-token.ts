/**
 * Verify the session token a checkout UI extension sends (shopify.sessionToken.get()): an HS256 JWT signed with the
 * app's client secret. Claims: dest = "<shop>.myshopify.com", aud = the app's client id, exp/nbf/iat, jti, optional sub.
 * The token only vouches for its claims, not for the rest of the request — never trust ids from the body for anything
 * sensitive without re-reading them server-side.
 */
import crypto from "crypto";

export interface SessionClaims {
  dest: string;
  aud: string;
  exp: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  sub?: string;
}

export type VerifyResult = { ok: true; claims: SessionClaims } | { ok: false; reason: string };

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Tolerance for clock skew between Shopify and Vercel, in seconds. */
const LEEWAY_S = 10;

export function verifySessionToken(
  token: string | null | undefined,
  opts: { secret: string; clientId: string; shopDomain: string; nowSec?: number },
): VerifyResult {
  if (!token) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "format" };
  const [h, p, sig] = parts;
  let header: { alg?: string };
  let claims: SessionClaims;
  try {
    header = JSON.parse(b64urlDecode(h).toString("utf8"));
    claims = JSON.parse(b64urlDecode(p).toString("utf8"));
  } catch {
    return { ok: false, reason: "format" };
  }
  if (header.alg !== "HS256") return { ok: false, reason: "alg" };
  const expected = crypto.createHmac("sha256", opts.secret).update(`${h}.${p}`).digest();
  const given = b64urlDecode(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: "signature" };

  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_S < now) return { ok: false, reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_S > now) return { ok: false, reason: "not-yet-valid" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.clientId)) return { ok: false, reason: "aud" };
  const dest = String(claims.dest ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (dest !== opts.shopDomain.toLowerCase()) return { ok: false, reason: "dest" };
  return { ok: true, claims };
}

/** Test helper + documentation of the format: sign claims the way Shopify does. */
export function signSessionToken(claims: Record<string, unknown>, secret: string): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = enc({ alg: "HS256", typ: "JWT" });
  const p = enc(claims);
  const s = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}
