import crypto from "crypto";
import { env } from "@/lib/config";

/**
 * Constant-time Bearer CRON_SECRET check, shared by every `/api/cron/*` route
 * plus the public-prefixed routes that authenticate server-to-server callers
 * (`/api/revalidate`, `/api/blog/generate`, `/api/social/content/*`).
 *
 * The `/api/cron`, `/api/blog`, `/api/revalidate` and `/api/social/content`
 * prefixes are in `proxy.ts` PUBLIC_PATHS, so these handlers are the ONLY auth
 * gate in front of paid / mutating work. Extracting one helper means "is this
 * route authenticated?" has a single answer and new routes opt in by import
 * instead of re-deriving the comparison (previously copy-pasted 16 times, with
 * drifting fail-closed behaviour — see SECURITY-BACKLOG P3-7).
 *
 * Fail-closed on every error path:
 *  - missing header        → false
 *  - CRON_SECRET unset     → false (env.cronSecret throws; caught here so the
 *                            route returns 401, never a 500 "Bearer undefined")
 *  - length mismatch       → false (also guards crypto.timingSafeEqual, which
 *                            throws on unequal-length buffers)
 */
export function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  let expected: string;
  try {
    expected = `Bearer ${env.cronSecret}`;
  } catch {
    return false; // CRON_SECRET not configured → 401, not 500
  }
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
