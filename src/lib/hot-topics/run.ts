/**
 * Hot-topic ("sujet chaud") post pipeline: collect → filter → write → card → draft.
 *
 * Modes (`settings.hot_topics_mode`): off (default; the cron is a no-op) | dry (collect, write and
 * render, but store NOTHING — no upload, no draft) | live (store the card + create ONE draft per run).
 * `live` never publishes anything: the draft lands as `status='draft'` and goes through the usual
 * human approval → publication_queue path. Nothing here approves, schedules or publishes.
 *
 * Caps: at most `hot_topics_weekly_cap` (default 2) non-rejected hot-topic drafts per rolling 7 days,
 * one per run, and never a topic close to one already used this week.
 */
import { countFacebookDraftsSince, createFacebookDraft, getAnyProductSku, getSetting, setSetting } from "@/lib/database";
import { collectCandidates } from "./sources";
import { generateHotTopicPosts, type HotTopicPost } from "./generator";
import { renderCardPng, uploadCardPng } from "./card";

export const MODE_KEY = "hot_topics_mode";
export const WEEKLY_CAP_KEY = "hot_topics_weekly_cap";
export const RECENT_KEY = "hot_topics_recent";
export const LAST_RUN_KEY = "hot_topics_last_run";
export const DEFAULT_WEEKLY_CAP = 2;
const WEEK_SEC = 7 * 86400;
const RECENT_KEEP = 40;

export type HotTopicsMode = "off" | "dry" | "live";

export function parseMode(v: string | null | undefined): HotTopicsMode {
  const m = (v ?? "").trim().toLowerCase();
  return m === "dry" || m === "live" ? m : "off";
}

export function parseCap(v: string | null | undefined): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 && n <= 14 ? n : DEFAULT_WEEKLY_CAP;
}

interface RecentTopic { title: string; at: number; draftId: number }

function tokens(s: string): Set<string> {
  return new Set(
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2),
  );
}

/** Jaccard overlap of the significant words of two titles. */
export function topicSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** True when `title` is about the same thing as a topic already used within the last week. */
export function isRecentDuplicate(title: string, recent: RecentTopic[], nowSec: number): boolean {
  return recent.some((r) => nowSec - r.at < WEEK_SEC && topicSimilarity(title, r.title) >= 0.4);
}

async function readRecent(): Promise<RecentTopic[]> {
  try {
    const raw = await getSetting(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as RecentTopic[]) : [];
  } catch {
    return [];
  }
}

export interface HotTopicsResult {
  mode: HotTopicsMode;
  skipped?: string;
  feeds?: Record<string, string>;
  candidates?: number;
  blockedBeforeLlm?: number;
  rejected?: Array<{ title: string; reason: string }>;
  /** What the run chose (and, in live mode, stored). */
  chosen?: {
    topic: string;
    source: string;
    category: string;
    divisive: number;
    lead: string;
    question: string;
    caption: string;
    why: string;
    cardFontSize: number;
    cardLines: string[];
    imageUrl?: string;
    draftId?: number;
  };
  /** Other valid proposals from the same run (dry-run review). */
  alternatives?: Array<{ topic: string; question: string; caption: string }>;
}

/** Run the pipeline. `modeOverride` can only DOWNGRADE (never turns live on): callers pass "dry". */
export async function runHotTopics(opts: { modeOverride?: "dry"; now?: Date } = {}): Promise<HotTopicsResult> {
  const now = opts.now ?? new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const configured = parseMode(await getSetting(MODE_KEY));
  const mode: HotTopicsMode = opts.modeOverride ?? configured;
  if (mode === "off") return { mode, skipped: "hot_topics_mode=off" };

  const cap = parseCap(await getSetting(WEEKLY_CAP_KEY));
  if (mode === "live") {
    const used = await countFacebookDraftsSince("hot_topic", nowSec - WEEK_SEC);
    if (used >= cap) return { mode, skipped: `plafond hebdo atteint (${used}/${cap})` };
  }

  const { candidates, feeds } = await collectCandidates();
  if (candidates.length === 0) return { mode, feeds, candidates: 0, skipped: "aucune source n'a répondu" };

  const outcome = await generateHotTopicPosts(candidates, now);
  const base: HotTopicsResult = {
    mode, feeds, candidates: candidates.length,
    blockedBeforeLlm: outcome.blockedBeforeLlm, rejected: outcome.rejected,
  };

  const recent = await readRecent();
  const fresh: HotTopicPost[] = outcome.posts.filter((p) => !isRecentDuplicate(p.candidate.title, recent, nowSec));
  if (fresh.length === 0) {
    const result = { ...base, skipped: "aucun sujet sûr, léger et nouveau aujourd'hui" };
    await recordLastRun(result, nowSec);
    return result;
  }

  const best = fresh[0];
  const { png, layout } = await renderCardPng(best.lead, best.question);
  const chosen: NonNullable<HotTopicsResult["chosen"]> = {
    topic: best.candidate.title, source: best.candidate.source, category: best.category,
    divisive: best.divisive, lead: best.lead, question: best.question, caption: best.caption,
    why: best.why, cardFontSize: layout.fontSize, cardLines: layout.lines,
  };
  const alternatives = fresh.slice(1).map((p) => ({ topic: p.candidate.title, question: p.question, caption: p.caption }));

  if (mode === "dry") {
    const result = { ...base, chosen, alternatives };
    await recordLastRun(result, nowSec);
    return result;
  }

  // live — store the card, create ONE draft in status 'draft' (human approval required).
  const sku = await getAnyProductSku();
  if (!sku) throw new Error("hot-topics: catalogue vide — aucun SKU de remplacement pour le brouillon éditorial");
  const imageUrl = await uploadCardPng(png, best.candidate.title);
  const draftId = await createFacebookDraft({
    sku, triggerType: "hot_topic", language: "fr", postText: best.caption,
    imageUrl, imageUrls: [imageUrl],
  });
  chosen.imageUrl = imageUrl;
  chosen.draftId = draftId;

  const updated: RecentTopic[] = [{ title: best.candidate.title, at: nowSec, draftId }, ...recent].slice(0, RECENT_KEEP);
  await setSetting(RECENT_KEY, JSON.stringify(updated));

  const result = { ...base, chosen, alternatives };
  await recordLastRun(result, nowSec);
  return result;
}

/** Best-effort audit trail: the last run's outcome, readable from the settings table. */
async function recordLastRun(result: HotTopicsResult, nowSec: number): Promise<void> {
  try {
    await setSetting(LAST_RUN_KEY, JSON.stringify({ at: nowSec, ...result }).slice(0, 8000));
  } catch (err) {
    console.warn("[hot-topics] could not record last run:", err);
  }
}

