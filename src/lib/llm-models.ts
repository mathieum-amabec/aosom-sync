/**
 * Which model serves each kind of LLM work — the one place that decides Claude vs Gemini.
 *
 * Two Gemini tiers, chosen from the 2026-10 quality tests (Haiku vs Flash-Lite vs 3.8 Flash on real
 * Ameublo inputs, blind-judged by Sonnet, planted-error checks for judges, ground-truth images):
 *
 *   "lite"   gemini-3.5-flash-lite — short copy (social captions, content templates, slogans, Google
 *            Business posts) and vision. Equal-or-better than Haiku there, ~3x cheaper and faster.
 *   "strong" gemini-3.8-flash      — long-form (blogs, guide drafts), JUDGES (fact-check 40/40 planted
 *            errors; Flash-Lite missed 7 and rates far too leniently on quality) and the Reel/video
 *            copy where Flash-Lite drops the "$" from prices.
 *
 * Not on this list on purpose: guide REVISION after a judge's notes stays on Claude Sonnet
 * (84.2 vs 78.8 for 3.8 Flash in the test) — callers pass CLAUDE.MODEL there explicitly.
 *
 * Gemini is used whenever GEMINI_API_KEY is configured (production already has it for the
 * storefront assistant); without it — a bare clone, or unit tests — every purpose falls back to
 * the historical Claude batch model, so nothing breaks. LLM_PROVIDER=anthropic forces Claude
 * everywhere (one-switch rollback); LLM_PROVIDER=gemini forces Gemini.
 *
 * Read from process.env directly (not config.ts) so tests that mock config keep working.
 */
import { CLAUDE } from "./config";

export type LlmTier = "lite" | "strong";

export const GEMINI_LITE_MODEL = "gemini-3.5-flash-lite";
export const GEMINI_STRONG_MODEL = "gemini-3.8-flash";

/** True when LLM work should be served by Gemini (see header for the rules). */
export function isGeminiEnabled(): boolean {
  const explicit = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit === "anthropic") return false;
  if (explicit === "gemini") return true;
  return !!process.env.GEMINI_API_KEY;
}

/** Model id for a tier: the Gemini model when Gemini is on, else the historical Claude batch model. */
export function llmModel(tier: LlmTier): string {
  if (!isGeminiEnabled()) return CLAUDE.MODEL_BATCH;
  return tier === "lite"
    ? process.env.GEMINI_LITE_MODEL?.trim() || GEMINI_LITE_MODEL
    : process.env.GEMINI_STRONG_MODEL?.trim() || GEMINI_STRONG_MODEL;
}
