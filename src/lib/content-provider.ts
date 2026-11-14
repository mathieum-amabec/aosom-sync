/**
 * Which model writes the FIRST draft of a product listing.
 *
 * Read from process.env directly (not via config.ts) so the choice can be flipped per deploy
 * with no code change, and so tests that mock config.ts keep working.
 *
 *   CONTENT_PROVIDER=gemini     — Gemini Flash-Lite first, then Gemini 3.8 Flash. No Claude in the path.
 *   CONTENT_PROVIDER=anthropic  — Claude Haiku first, then Claude Sonnet (the historical chain).
 *   unset / anything else       — gemini WHEN GEMINI_API_KEY is configured, otherwise anthropic.
 *
 * So every environment that already has the Gemini key (production runs the storefront assistant
 * on it) writes product copy with Gemini by default, and a clone without the key keeps working
 * on Claude instead of failing. Set CONTENT_PROVIDER=anthropic to force the old behaviour.
 *
 * Whatever writes the draft, the SAME prompt, validators and guardrails (content-guards.ts)
 * apply. Basis: the 2026-10 A/B (30 products) — Gemini ~3x cheaper and ~3x faster with
 * equal-or-better copy on a blind read.
 */
import { isGeminiEnabled, GEMINI_LITE_MODEL, GEMINI_STRONG_MODEL } from "./llm-models";

export type ContentProvider = "anthropic" | "gemini";

export function getContentProvider(): ContentProvider {
  const explicit = process.env.CONTENT_PROVIDER?.trim().toLowerCase();
  if (explicit === "anthropic" || explicit === "gemini") return explicit;
  return isGeminiEnabled() ? "gemini" : "anthropic";
}

/** Gemini model used for the first draft when the provider is gemini (override: GEMINI_CONTENT_MODEL). */
export function getContentGeminiModel(): string {
  return process.env.GEMINI_CONTENT_MODEL?.trim() || GEMINI_LITE_MODEL;
}

/** Stronger Gemini behind the first tier, used only when its output fails validation (override: GEMINI_CONTENT_STRONG_MODEL). */
export function getContentGeminiStrongModel(): string {
  return process.env.GEMINI_CONTENT_STRONG_MODEL?.trim() || GEMINI_STRONG_MODEL;
}
