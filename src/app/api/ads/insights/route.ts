import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { env } from "@/lib/config";
import { getAdAccounts, getInsights, defaultAdAccountId } from "@/lib/meta-ads-client";
import { aggregateInsights, rangeForDays, parseDays, type AdsMetrics } from "@/lib/ads-insights";

/**
 * GET /api/ads/insights?days=30
 *
 * Aggregated Meta Ads metrics for the dashboard "Publicités Meta" panel:
 * spend (CAD), reach, clicks, ROAS, CPM, CTR over the last `days` days
 * (default 30, clamped 1–365). Session-protected (isAuthenticated).
 *
 * Cached in-process for 1h, keyed by (adAccountId, days) — ad metrics don't
 * change minute-to-minute, so a warm instance reuses the last Graph fetch instead
 * of re-querying on every dashboard mount. The cache is per-instance and resets on
 * cold start (best-effort budget guard, not a distributed quota — serverless fan-out
 * means each instance keeps its own copy). The response is `Cache-Control: no-store`:
 * this is auth-gated data, so we never let the browser/CDN cache it by URL where a
 * later OS user could read a prior session's numbers from disk cache.
 *
 * Note: Meta interprets `time_range` in the ad account's own timezone; we send UTC
 * day boundaries, so the 30-day window can be off by up to a day at the edges. That's
 * immaterial for a headline metric and avoids per-account timezone bookkeeping.
 */

export const dynamic = "force-dynamic"; // we manage caching ourselves

interface InsightsPayload {
  configured: true;
  adAccountId: string;
  currency: string;
  days: number;
  range: { since: string; until: string };
  metrics: AdsMetrics;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const cache = new Map<string, { at: number; payload: InsightsPayload }>();

export async function GET(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Token absent → tell the panel to render the "connect your account" CTA.
  // 200 (not 4xx) is intentional: "not set up yet" is a normal state for the panel,
  // not a request error. `reason` lets other consumers distinguish the two CTA cases.
  if (!env.hasMetaAccessToken) {
    return NextResponse.json(
      { configured: false, reason: "no_token", error: "META_ACCESS_TOKEN not configured", setupDoc: "docs/META-ADS-SETUP.md" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  const days = parseDays(new URL(request.url).searchParams.get("days"));

  try {
    const accounts = await getAdAccounts();
    if (accounts.length === 0) {
      return NextResponse.json(
        { configured: false, reason: "no_accounts", error: "No ad accounts available for this token", setupDoc: "docs/META-ADS-SETUP.md" },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
    // Selection order: the configured META_AD_ACCOUNT_ID (matched in the list so we
    // keep its currency), else an ACTIVE account (account_status === 1) so a
    // closed/disabled first account doesn't show empty numbers, else the first.
    const configured = defaultAdAccountId();
    const account =
      (configured ? accounts.find((a) => a.id === configured) : undefined) ??
      accounts.find((a) => a.account_status === 1) ??
      accounts[0];
    const cacheKey = `${account.id}:${days}`;

    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return NextResponse.json(hit.payload, {
        headers: { "Cache-Control": "no-store", "X-Cache": "HIT" },
      });
    }

    const range = rangeForDays(days, new Date());
    const rows = await getInsights(account.id, range);
    const payload: InsightsPayload = {
      configured: true,
      adAccountId: account.id,
      currency: account.currency || "CAD",
      days,
      range,
      metrics: aggregateInsights(rows),
    };
    cache.set(cacheKey, { at: Date.now(), payload });

    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store", "X-Cache": "MISS" },
    });
  } catch (err) {
    console.error(`[API] GET /api/ads/insights?days=${days} failed:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 502 },
    );
  }
}
