/**
 * Cost estimation for the `daily_llm_budget` counters.
 *
 * ⚠️ The counter is a SINGLE combined number per (day, pool) — `recordLlmUsage` stores
 * `input_tokens + output_tokens` and nothing splits them. Anthropic bills input and output
 * at very different rates ($1 vs $5 per MTok on Haiku 4.5, which both pools now run), so any
 * dollar figure derived from that counter rests on an assumed split. This module makes that
 * assumption explicit, per pool, instead of burying a magic number in a component.
 *
 * The splits below come from the actual call shapes:
 *   - `assistant` — system prompt + tool schema + catalogue rows in, `max_tokens: 1024` of
 *     French prose out, up to MAX_STEPS times. Heavily input-weighted.
 *   - `batch`     — an Aosom description in, up to `MAX_TOKENS_CONTENT` (4000) of bilingual
 *     HTML out. Output-weighted.
 *
 * Every figure this module produces is an ESTIMATE and must be labelled as such in the UI.
 * The Anthropic console is the only source that knows the real split.
 */
import { CLAUDE } from "./config";
import type { LlmBudgetPool } from "./database";

/** USD per million tokens, per model. Mirrors Anthropic's public list price. */
export const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
};

/** Fallback when a pool runs a model absent from MODEL_PRICING — priced as Sonnet 4.6 so
 *  an unknown model is never estimated as free. */
const FALLBACK_PRICING = MODEL_PRICING["claude-sonnet-4-6"];

/**
 * Strip a trailing `-YYYYMMDD` snapshot suffix so a dated model id prices off its family.
 * Without this, `claude-haiku-4-5-20251001` misses every MODEL_PRICING key and falls back
 * to Sonnet rates — a 3× over-estimate of the assistant pool's cost, silently.
 */
export function pricingKey(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

/** Assumed share of the combined counter that is INPUT, per pool. See the file header. */
export const ASSUMED_INPUT_SHARE: Record<LlmBudgetPool, number> = {
  assistant: 0.9,
  batch: 0.4,
};

/** The model each pool currently runs. Reads config, so the CLAUDE_ASSISTANT_MODEL /
 *  CLAUDE_BATCH_MODEL overrides are reflected in the estimate without a code change. */
export function poolModel(pool: LlmBudgetPool): string {
  return pool === "assistant" ? CLAUDE.MODEL_ASSISTANT : CLAUDE.MODEL_BATCH;
}

/**
 * Blended USD per million tokens for a pool: its model's input and output rates weighted
 * by the assumed split. One number per pool keeps the arithmetic in one place.
 */
export function blendedRatePerMTok(pool: LlmBudgetPool): number {
  const pricing = MODEL_PRICING[pricingKey(poolModel(pool))] ?? FALLBACK_PRICING;
  const inShare = ASSUMED_INPUT_SHARE[pool];
  return pricing.inputPerMTok * inShare + pricing.outputPerMTok * (1 - inShare);
}

/** Estimated USD for `tokens` combined tokens spent on `pool`. Never negative. */
export function estimateCostUsd(pool: LlmBudgetPool, tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return (tokens / 1_000_000) * blendedRatePerMTok(pool);
}

/** The UTC day keys for the last `days` days, oldest first, ending with today. */
export function utcDayKeys(days: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime());
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
