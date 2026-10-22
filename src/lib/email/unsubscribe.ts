/**
 * Signed unsubscribe links. The token proves the link was issued for this address, so nobody can
 * unsubscribe someone else by guessing URLs, and no lookup table is needed. Secret:
 * EMAIL_TOKEN_SECRET (≥ 32 chars). Without it, no link can be built and engine.ts refuses to send.
 */
import crypto from "node:crypto";

export const UNSUB_PATH = "/api/email/unsubscribe";

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** The form every table keys on: trimmed, lower-case. Aliases (`a+x@`) stay distinct on purpose. */
export const emailKey = (email: string) => email.trim().toLowerCase();

export function tokenSecret(env: Record<string, string | undefined> = process.env): string | null {
  const s = env.EMAIL_TOKEN_SECRET;
  return s && s.length >= 32 ? s : null;
}

/**
 * Secrets an incoming link may be signed with: the current one, plus EMAIL_TOKEN_SECRET_PREVIOUS
 * after a rotation (CASL: an unsubscribe link must keep working at least 60 days after sending).
 */
export function acceptedSecrets(env: Record<string, string | undefined> = process.env): string[] {
  return [env.EMAIL_TOKEN_SECRET, env.EMAIL_TOKEN_SECRET_PREVIOUS].filter((s): s is string => !!s && s.length >= 32);
}

function sign(email: string, secret: string): string {
  return b64url(crypto.createHmac("sha256", secret).update(`unsub:v1:${emailKey(email)}`).digest());
}

export function unsubscribeUrl(baseUrl: string, email: string, secret: string): string {
  const e = b64url(Buffer.from(emailKey(email), "utf8"));
  return `${baseUrl.replace(/\/$/, "")}${UNSUB_PATH}?e=${e}&t=${sign(email, secret)}`;
}

/** The address the link was issued for, or null when the link was forged or mangled. */
export function verifyUnsubscribe(e: string | null, t: string | null, secret: string): string | null {
  if (!e || !t || e.length > 400 || t.length > 100) return null;
  const email = fromB64url(e).toString("utf8");
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return null;
  const want = Buffer.from(sign(email, secret));
  const got = Buffer.from(t);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? email : null;
}
