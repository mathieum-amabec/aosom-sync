import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { env } from "@/lib/config";
import { getDashboardAlerts } from "@/lib/database";
import { getTokenInfo } from "@/lib/meta-ads-client";
import { tokenExpiryStatus, type TokenExpiryState } from "@/lib/dashboard-metrics";

/**
 * GET /api/dashboard/alerts — "Alertes" panel.
 * Session-protected. Returns import jobs in error, social drafts pending > 7 days, the
 * last fetch per feed, and Meta token expiry (via Graph debug_token). Token info is cached
 * in-process for 1h so the dashboard doesn't probe the Graph API on every load.
 */
export const dynamic = "force-dynamic";

interface MetaTokenAlert {
  configured: boolean;
  state?: TokenExpiryState | "unknown";
  daysLeft?: number | null;
  expiresAt?: number; // 0 = never
}

let tokenCache: { at: number; value: MetaTokenAlert } | null = null;
const TOKEN_TTL_MS = 60 * 60 * 1000;

async function metaTokenAlert(): Promise<MetaTokenAlert> {
  if (!env.hasMetaAccessToken) return { configured: false };
  if (tokenCache && Date.now() - tokenCache.at < TOKEN_TTL_MS) return tokenCache.value;
  let value: MetaTokenAlert;
  try {
    const info = await getTokenInfo();
    const status = tokenExpiryStatus({ isValid: info.isValid, expiresAt: info.expiresAt }, new Date());
    value = { configured: true, state: status.state, daysLeft: status.daysLeft, expiresAt: info.expiresAt };
  } catch {
    // Graph error (network / revoked). Surface as "unknown" rather than failing the panel.
    value = { configured: true, state: "unknown", daysLeft: null };
  }
  tokenCache = { at: Date.now(), value };
  return value;
}

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const [alerts, metaToken] = await Promise.all([getDashboardAlerts(), metaTokenAlert()]);
    return NextResponse.json({ ...alerts, metaToken }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/dashboard/alerts failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
