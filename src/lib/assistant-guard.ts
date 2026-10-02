/**
 * Abuse protection for the public storefront assistant (Ameublo / Furni), on top of the
 * existing per-IP hourly quota, in-memory burst limits, rapid-fire guard and daily pool.
 *
 *   1. PER-VISITOR DAILY TOKEN CAP — one address can spend at most DAILY_TOKENS_PER_IP
 *      tokens a UTC day (~10 normal conversations), so no single visitor can drain the
 *      shared `assistant` pool and take the chat down for everyone else.
 *   2. ABUSE SCORE — each message is scored for jailbreak attempts, oversized / pasted
 *      payloads, verbatim repeats and model-flagged off-topic or abusive requests. Points
 *      accumulate per address per day; at ABUSE_BLOCK_SCORE the address is blocked for 24 h,
 *      and a repeat offender for 7 days. Blocks are listed (and liftable) in the dashboard.
 *
 * Addresses are stored HASHED (salted SHA-256, truncated): enough to recognise the same
 * visitor, never the raw IP (Québec Law 25 — no personal data we don't need).
 */
import { createHash } from "crypto";

/** ~10 ordinary conversations at the ~2.7k tokens each measured on Gemini (2026-10-02). */
export const DAILY_TOKENS_PER_IP = Number(process.env.ASSISTANT_DAILY_TOKENS_PER_IP) || 30_000;
/** Points in one UTC day that trigger an automatic block. */
export const ABUSE_BLOCK_SCORE = 6;
export const FIRST_BLOCK_SECS = 24 * 3600;
export const REPEAT_BLOCK_SECS = 7 * 24 * 3600;

export function hashIp(ip: string): string {
  const salt = process.env.ASSISTANT_IP_SALT || process.env.SESSION_SECRET || "ameublo-assistant";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 24);
}

/**
 * Prompt-injection / jailbreak phrasings, FR + EN. Deliberately specific: an innocent
 * shopper never writes "ignore tes instructions" or "system prompt", so a match is a strong
 * signal and scores high.
 */
const JAILBREAK = [
  /ignor\w*\s+(?:[\wéèà']+\s+){0,3}(r[eè]gles|instructions?|consignes|rules|directives)/i,
  /(system|syst[eè]me)\s*prompt|prompt\s+syst[eè]me/i,
  /(oublie|forget)\s+(tout|everything|tes|your)/i,
  /\b(jailbreak|DAN mode|developer mode|mode d[ée]veloppeur)\b/i,
  /(pretend|fais semblant|act as|agis comme|tu es maintenant|you are now)\b/i,
  /(r[eé]v[eè]le|reveal|montre|show|print|affiche)\s+(tes|your|the|les)\s+(instructions|consignes|r[eè]gles|prompt)/i,
];

export interface AbuseSignals {
  score: number;
  reasons: string[];
}

/** Score one incoming message against the conversation so far. Pure; exported for tests. */
export function scoreMessage(message: string, history: { role: string; content: string }[]): AbuseSignals {
  const reasons: string[] = [];
  let score = 0;
  if (JAILBREAK.some((re) => re.test(message))) {
    score += 3;
    reasons.push("jailbreak");
  }
  if (message.length > 600) {
    score += 1;
    reasons.push("long_message");
  }
  const codeChars = (message.match(/[{};<>=]/g) ?? []).length;
  if ((message.match(/https?:\/\//g) ?? []).length >= 3 || (message.length > 200 && codeChars >= 12)) {
    score += 1;
    reasons.push("pasted_payload");
  }
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const repeats = history.filter((t) => t.role === "user" && norm(t.content) === norm(message)).length;
  if (repeats >= 2) {
    score += 2;
    reasons.push("repeated_message");
  }
  return { score, reasons };
}

/** Points for the model's own verdict on the request (see the FINAL ANSWER `flag`). */
export function scoreModelFlag(flag: string | null | undefined): AbuseSignals {
  if (flag === "abuse") return { score: 3, reasons: ["model_abuse"] };
  if (flag === "off_topic") return { score: 1, reasons: ["model_off_topic"] };
  return { score: 0, reasons: [] };
}

/** How long to block, given how many times this address was already blocked. */
export function blockDurationSecs(previousStrikes: number): number {
  return previousStrikes >= 1 ? REPEAT_BLOCK_SECS : FIRST_BLOCK_SECS;
}
