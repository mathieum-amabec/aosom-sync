/**
 * Answer cache for the storefront assistant's FIRST question (2026-10-02).
 *
 * The widget's quick-question chips ("Délais et frais de livraison", "Comment fonctionnent les
 * retours?"…) send the exact same text for every shopper, and an opening question with no
 * history has nothing personal in it — so the same answer can be served for an hour instead
 * of re-running the 2-5 step tool loop (~6-16k tokens) each time. Measured cost driver: the
 * prompt + tools re-sent on every step, not the reply itself.
 *
 * Only first messages (no history) are cached, and only real answers: never a hand-off, a
 * flagged (off-topic / abuse) request, or the "no products found" line. One hour keeps prices,
 * stock and policies fresh; the live / draft check already ran on the cached cards.
 */
import { createHash } from "node:crypto";
import { ensureSchema } from "@/lib/database";
import type { AssistantResult, Locale } from "@/lib/assistant";

export const ANSWER_TTL_SECS = 60 * 60;

/** Case / accent-spacing / trailing-punctuation insensitive, so "Retours ?" = "retours". */
export function normalizeQuestion(message: string): string {
  return message
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s?!.…]+$/u, "")
    .trim();
}

export function answerCacheKey(message: string, locale: Locale): string {
  return createHash("sha1").update(`${locale}|${normalizeQuestion(message)}`).digest("hex");
}

/** Whether an answer is safe to replay to other shoppers. Exported for tests. */
export function isCacheableAnswer(result: AssistantResult): boolean {
  if (!result.reply) return false;
  if (result.meta?.flag) return false;
  if (/^(Je n'ai pas trouvé|I couldn't find)/.test(result.reply)) return false;
  if ((result as { limitReached?: boolean }).limitReached) return false;
  return true;
}

export async function getCachedAnswer(key: string, nowSec = Math.floor(Date.now() / 1000)): Promise<AssistantResult | null> {
  const db = await ensureSchema();
  const r = await db.execute({ sql: `SELECT payload, created_at FROM assistant_answer_cache WHERE cache_key = ?`, args: [key] });
  const row = r.rows[0];
  if (!row || nowSec - Number(row.created_at) > ANSWER_TTL_SECS) return null;
  try {
    return JSON.parse(String(row.payload)) as AssistantResult;
  } catch {
    return null;
  }
}

/** Store the shopper-facing part only (reply + cards), never the bookkeeping `meta`. */
export async function putCachedAnswer(key: string, result: AssistantResult, nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
  if (!isCacheableAnswer(result)) return;
  const db = await ensureSchema();
  await db.execute({
    sql: `INSERT INTO assistant_answer_cache (cache_key, payload, created_at) VALUES (?, ?, ?)
          ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
    args: [key, JSON.stringify({ reply: result.reply, products: result.products }), nowSec],
  });
}
