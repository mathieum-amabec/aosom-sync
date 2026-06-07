import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { env } from "@/lib/config";
import {
  getAdAccounts,
  getCampaigns,
  getInsights,
  type DateRange,
} from "@/lib/meta-ads-client";

/**
 * Meta Ads dashboard API. Session-protected (isAuthenticated).
 *
 * Single route, dispatched on `?resource=`:
 *   GET /api/ads?resource=accounts                      → ad accounts
 *   GET /api/ads?resource=campaigns[&adAccountId=...]   → active campaigns
 *   GET /api/ads?resource=insights[&adAccountId=...]    → current-month metrics
 *
 * When adAccountId is omitted for campaigns/insights, the first manageable ad
 * account is used.
 */

/** First and last day of the current month as YYYY-MM-DD (UTC). */
function currentMonthRange(now: Date): DateRange {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  const since = `${y}-${pad(m + 1)}-01`;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const until = `${y}-${pad(m + 1)}-${pad(lastDay)}`;
  return { since, until };
}

async function resolveAdAccountId(explicit: string | null): Promise<string> {
  if (explicit) return explicit;
  const accounts = await getAdAccounts();
  if (accounts.length === 0) throw new Error("No ad accounts available for this token");
  return accounts[0].id;
}

export async function GET(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!env.hasMetaAccessToken) {
    return NextResponse.json(
      { error: "META_ACCESS_TOKEN not configured — see docs/META-ADS-SETUP.md" },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const resource = searchParams.get("resource") ?? "accounts";
  const adAccountIdParam = searchParams.get("adAccountId");

  try {
    switch (resource) {
      case "accounts": {
        return NextResponse.json({ accounts: await getAdAccounts() });
      }
      case "campaigns": {
        const adAccountId = await resolveAdAccountId(adAccountIdParam);
        return NextResponse.json({ adAccountId, campaigns: await getCampaigns(adAccountId) });
      }
      case "insights": {
        const adAccountId = await resolveAdAccountId(adAccountIdParam);
        const range = currentMonthRange(new Date());
        return NextResponse.json({ adAccountId, range, insights: await getInsights(adAccountId, range) });
      }
      default:
        return NextResponse.json(
          { error: `Unknown resource "${resource}". Use accounts | campaigns | insights.` },
          { status: 400 },
        );
    }
  } catch (err) {
    console.error(`[API] GET /api/ads?resource=${resource} failed:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}
