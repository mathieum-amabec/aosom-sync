import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { env } from "@/lib/config";
import { getDailyLlmTokensUsed, getDashboardAlerts } from "@/lib/database";
import { poolBudget, type BudgetPool } from "@/lib/llm-budget";
import { getTokenInfo } from "@/lib/meta-ads-client";
import { llmPoolStatus, tokenExpiryStatus, type LlmPoolStatus, type TokenExpiryState } from "@/lib/dashboard-metrics";

/**
 * GET /api/dashboard/alerts — "Alertes" panel.
 * Session-protected. Returns import jobs in error, social drafts pending > 7 days, the
 * last fetch per feed, Meta token expiry (via Graph debug_token), and per-pool LLM budget
 * pressure. Token info is cached in-process for 1h so the dashboard doesn't probe the
 * Graph API on every load.
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

const LLM_POOLS: BudgetPool[] = ["assistant", "batch"];

/**
 * Today's (UTC) budget pressure per pool. Composed here rather than in
 * `getDashboardAlerts` because the budget CEILING lives in llm-budget.ts, which already
 * imports database.ts — reading it from inside database.ts would be a cycle.
 *
 * Deliberately NOT wrapped in the alerts metric cache: `assertLlmBudget` reads the same
 * counter live, so a cached panel could tell the operator a pool is fine while calls are
 * already being refused. The read is a single indexed row per pool.
 *
 * Fails soft: a budget-store error returns [] so the rest of the panel still renders —
 * the same posture `assertLlmBudget` takes (fail-open on infra error).
 */
async function llmBudgetAlerts(): Promise<LlmPoolStatus[]> {
  try {
    return await Promise.all(
      LLM_POOLS.map(async (pool) => llmPoolStatus(pool, await getDailyLlmTokensUsed(pool), poolBudget(pool))),
    );
  } catch (err) {
    console.warn("[API] alerts: LLM budget read failed —", err instanceof Error ? err.message : String(err));
    return [];
  }
}

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const [alerts, metaToken, llmPools] = await Promise.all([
      getDashboardAlerts(),
      metaTokenAlert(),
      llmBudgetAlerts(),
    ]);
    return NextResponse.json({ ...alerts, metaToken, llmPools }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/dashboard/alerts failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
