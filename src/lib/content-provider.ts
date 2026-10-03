/**
 * Which model writes the FIRST draft of a product listing.
 *
 * Read from process.env directly (not via config.ts) so the choice can be flipped per deploy
 * with no code change, and so tests that mock config.ts keep working.
 *
 *   CONTENT_PROVIDER=anthropic  (default) — Claude Haiku first tier, Sonnet on validation failure.
 *   CONTENT_PROVIDER=gemini               — Gemini Flash-Lite first tier, Sonnet on validation failure.
 *
 * Either way the SAME prompt, validators and guardrails (content-guards.ts) apply, and the
 * escalation tier stays Claude Sonnet. Basis: the 2026-10 A/B (30 products) — Gemini was ~3x
 * cheaper and ~3x faster with equal-or-better copy on a blind read.
 */
export type ContentProvider = "anthropic" | "gemini";

export function getContentProvider(): ContentProvider {
  return process.env.CONTENT_PROVIDER?.trim().toLowerCase() === "gemini" ? "gemini" : "anthropic";
}

/** Gemini model used for the first draft when CONTENT_PROVIDER=gemini (override: GEMINI_CONTENT_MODEL). */
export function getContentGeminiModel(): string {
  return process.env.GEMINI_CONTENT_MODEL?.trim() || "gemini-3.5-flash-lite";
}
