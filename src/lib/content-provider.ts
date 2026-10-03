/**
 * Which model writes the FIRST draft of a product listing.
 *
 * Read from process.env directly (not via config.ts) so the choice can be flipped per deploy
 * with no code change, and so tests that mock config.ts keep working.
 *
 *   CONTENT_PROVIDER=gemini     — Gemini Flash-Lite first, then Claude Haiku, then Claude Sonnet.
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
export type ContentProvider = "anthropic" | "gemini";

export function getContentProvider(): ContentProvider {
  const explicit = process.env.CONTENT_PROVIDER?.trim().toLowerCase();
  if (explicit === "anthropic" || explicit === "gemini") return explicit;
  return process.env.GEMINI_API_KEY ? "gemini" : "anthropic";
}

/** Gemini model used for the first draft when the provider is gemini (override: GEMINI_CONTENT_MODEL). */
export function getContentGeminiModel(): string {
  return process.env.GEMINI_CONTENT_MODEL?.trim() || "gemini-3.5-flash-lite";
}
