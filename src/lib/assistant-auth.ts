/**
 * Shared-secret token for the public storefront assistant.
 *
 * ## What this is, and what it is not
 *
 * The endpoint's only identity gate used to be the `Origin` header, which any non-browser
 * client sets freely (`curl -H 'Origin: https://ameublodirect.ca'` passes it). This adds a
 * rotating token derived from `ASSISTANT_SECRET`, so a caller has to know something rather
 * than merely claim something.
 *
 * It is NOT authentication, and pretending otherwise would be worse than not shipping it.
 * The widget is an inline `<script>` in a public Shopify theme: everything it holds is
 * readable with View Source, so a determined caller can always lift the current token. What
 * this buys is real but bounded — it stops opportunistic scanners and generic bots, the
 * token rotates daily so a scraped value dies within 24h, and rotating `ASSISTANT_SECRET`
 * revokes every copy at once. The actual spend ceiling is the Turso per-IP quota and the
 * daily token budget; this is the doorman, not the vault.
 *
 * ## Rollout order matters
 *
 * The deployed widget sends no custom headers today. If the route demanded a token
 * unconditionally, the storefront assistant would go dark the moment this deploys. So the
 * check is **gated on the env var**: no `ASSISTANT_SECRET` set means no token required
 * (today's behaviour). Set the variable only AFTER the theme snippet has been updated to
 * send the header. `scripts/assistant-token.mts` prints the value and the snippet to paste.
 */

import crypto from "crypto";

/** Header the storefront widget sends. Must also appear in the CORS preflight allowlist. */
export const ASSISTANT_TOKEN_HEADER = "x-assistant-token";

/**
 * Today's token: HMAC-SHA256(secret, "YYYY-MM-DD") truncated to 32 hex chars.
 *
 * The date is taken in UTC so the server and every client agree on the boundary regardless
 * of where the shopper is. 128 bits of the digest is far more than enough for a value whose
 * whole job is to be unguessable for a day, and a shorter string keeps the theme snippet
 * readable.
 */
export function assistantDailyToken(secret: string, date: Date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  return crypto.createHmac("sha256", secret).update(day).digest("hex").slice(0, 32);
}

export type TokenVerdict = "ok" | "missing" | "invalid" | "not_configured";

/** Length-safe constant-time compare. `timingSafeEqual` throws on unequal lengths. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify the caller's token.
 *
 * Accepts **today's or yesterday's** UTC token. Without that grace, every shopper mid-
 * conversation at 00:00 UTC gets rejected, and any page loaded before midnight keeps sending
 * a stale value until it is reloaded — a daily burst of false failures on a customer-facing
 * widget, in exchange for nothing: a one-day-old token is already worthless to an attacker
 * who can simply read the current one off the page.
 *
 * Returns `not_configured` when `ASSISTANT_SECRET` is unset so the caller can stay open
 * during rollout instead of taking the storefront assistant down. See the note above.
 */
export function verifyAssistantToken(header: string | null, now: Date = new Date()): TokenVerdict {
  const secret = process.env.ASSISTANT_SECRET?.trim();
  if (!secret) return "not_configured";
  if (!header) return "missing";

  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  for (const d of [now, yesterday]) {
    if (safeEqual(header, assistantDailyToken(secret, d))) return "ok";
  }
  return "invalid";
}
