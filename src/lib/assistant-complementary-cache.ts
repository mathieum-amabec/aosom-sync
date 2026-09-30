/**
 * Cache + crawler guard for the PDP "Complétez la pièce" block (/api/assistant mode=complementary).
 *
 * Measured 2026-09-29: the theme snippet (lc-complete-the-room) calls the assistant on EVERY
 * product-page view — ~1,100 calls/day, i.e. page views, not shopper conversations. They drained
 * the 500k-token assistant pool ~86 min after the UTC reset (≈ 20:30 Montréal); after that the
 * block silently hid itself and the chat widget served the hand-off card to real shoppers.
 * The suggestions for a given product barely change within a day, so they're computed once per
 * product per TTL, and search-engine crawlers (which run page JS) never trigger an LLM call.
 */
import { createHash } from "node:crypto";
import { ensureSchema } from "@/lib/database";
import type { AssistantResult, Locale } from "@/lib/assistant";

export const COMPLEMENTARY_TTL_SECS = 24 * 60 * 60;

/** Crawlers / previewers that execute page JS (Googlebot renders PDPs) or fetch it for previews. */
const BOT_UA = /bot\b|crawler|spider|slurp|googlebot|adsbot|google-inspectiontool|bingbot|bingpreview|duckduckbot|baiduspider|yandex|applebot|facebookexternalhit|meta-externalagent|headlesschrome|lighthouse|pagespeed|ahrefs|semrush|mj12bot|petalbot|bytespider|gptbot|claudebot|perplexitybot|ccbot/i;

export function isBotUserAgent(ua: string | null | undefined): boolean {
  // No UA isn't treated as a bot: the Origin + token gates already stop header-less scripts.
  return !!ua && BOT_UA.test(ua);
}

/** Same product + category + language → same key (case/whitespace-insensitive). */
export function complementaryCacheKey(name: string, productType: string, locale: Locale): string {
  const norm = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha1").update(`${locale}|${norm(productType)}|${norm(name)}`).digest("hex");
}

export async function getCachedComplementary(key: string, nowSec = Math.floor(Date.now() / 1000)): Promise<AssistantResult | null> {
  const db = await ensureSchema();
  const r = await db.execute({
    sql: `SELECT payload, created_at FROM assistant_complementary_cache WHERE cache_key = ?`,
    args: [key],
  });
  const row = r.rows[0];
  if (!row || nowSec - Number(row.created_at) > COMPLEMENTARY_TTL_SECS) return null;
  try {
    return JSON.parse(String(row.payload)) as AssistantResult;
  } catch {
    return null;
  }
}

export async function putCachedComplementary(key: string, result: AssistantResult, nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
  // Only cache real suggestions: an empty answer (e.g. a transient search miss) should be retried.
  if (!result.products?.length) return;
  const db = await ensureSchema();
  await db.execute({
    sql: `INSERT INTO assistant_complementary_cache (cache_key, payload, created_at) VALUES (?, ?, ?)
          ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
    args: [key, JSON.stringify(result), nowSec],
  });
}
