// Pure helpers for the dashboard "Résumé du jour" + "Alertes" panels (no I/O —
// fully unit-testable). The DB queries live in database.ts; the route composes them.

/** Start of the current UTC day as epoch seconds (for "imported today" windows). */
export function startOfUtcDayEpoch(now: Date): number {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
}

/** Epoch seconds exactly `days` * 24h before `now` (for rolling "this week"/">7d" windows). */
export function epochDaysAgo(now: Date, days: number): number {
  return Math.floor(now.getTime() / 1000) - days * 86400;
}

/** Estimated revenue from Meta ad metrics: revenue = ROAS × spend. null when no metrics. */
export function estimatedRevenue(metrics: { roas: number; spend: number } | null | undefined): number | null {
  if (!metrics) return null;
  return Math.round((metrics.roas * metrics.spend + Number.EPSILON) * 100) / 100;
}

export interface TokenInfo {
  isValid: boolean;
  /** Epoch seconds the token expires; 0 or null means "never expires" (system-user token). */
  expiresAt: number | null;
}
export type TokenExpiryState = "ok" | "expiring_soon" | "expired" | "never" | "invalid";
export interface TokenExpiryStatus {
  state: TokenExpiryState;
  /** Whole days until expiry; null when never-expires / invalid / unknown. */
  daysLeft: number | null;
}

/** Classify a Meta token's expiry. Call only when the token is configured; pass the
 * debug_token result. "expiring_soon" fires within 7 days so the alert lands early. */
export function tokenExpiryStatus(info: TokenInfo, now: Date): TokenExpiryStatus {
  if (!info.isValid) return { state: "expired", daysLeft: null };
  if (!info.expiresAt || info.expiresAt <= 0) return { state: "never", daysLeft: null };
  const secs = info.expiresAt - Math.floor(now.getTime() / 1000);
  if (secs <= 0) return { state: "expired", daysLeft: 0 };
  const daysLeft = Math.floor(secs / 86400);
  return { state: daysLeft <= 7 ? "expiring_soon" : "ok", daysLeft };
}

/** True when an alert badge should be raised for the token (expired or expiring soon). */
export function tokenNeedsAttention(status: TokenExpiryStatus): boolean {
  return status.state === "expired" || status.state === "expiring_soon";
}
