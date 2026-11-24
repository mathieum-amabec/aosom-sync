/**
 * Hot-topic ("sujet chaud") post pipeline: pick a kind → source → write → card → draft.
 *
 * Two kinds of post, alternated week by week (the review's mix):
 *  - "news": a named, fresh story or hard fact (Journal de Montréal / La Presse headlines, the NHL
 *    score) turned into a question by the LLM, every name and number verified against the source.
 *  - "calendar": a dated or seasonal topic from the pre-written bank (pneus d'hiver, Vendredi fou,
 *    sapin de Noël…). No LLM, no feed — it cannot be wrong or off-brand.
 *
 * Modes (`settings.hot_topics_mode`): off (default; the cron is a no-op) | dry (collect, write and
 * render, but store NOTHING — no upload, no draft) | live (store the card + create ONE draft per run).
 * `live` never publishes anything: the draft lands as `status='draft'` and goes through the usual
 * human approval → publication_queue path. Nothing here approves, schedules or publishes. The draft
 * carries its source (`topic_meta`) so the approver sees what it is about, and an expiry that the
 * publisher enforces (hot-topics/guard.ts).
 *
 * Caps: at most `hot_topics_weekly_cap` (default 2) non-rejected hot-topic drafts per rolling 7 days,
 * one per run, never a topic close to one already used, and the kind not yet used this week goes first.
 */
import { countFacebookDraftsSince, createFacebookDraft, getAnyProductSku, getSetting, setSetting } from "@/lib/database";
import { calendarPosts } from "./calendar";
import { collectCandidates } from "./sources";
import { checkPostText, generateHotTopicPosts, rankPosts, type HotTopicPost } from "./generator";
import { renderCardPng, uploadCardPng } from "./card";

export const MODE_KEY = "hot_topics_mode";
export const WEEKLY_CAP_KEY = "hot_topics_weekly_cap";
export const RECENT_KEY = "hot_topics_recent";
export const LAST_RUN_KEY = "hot_topics_last_run";
export const DEFAULT_WEEKLY_CAP = 2;
const WEEK_SEC = 7 * 86400;
/** A calendar post is not repeated for this long. */
const CALENDAR_REPEAT_SEC = 10 * 86400;
const RECENT_KEEP = 40;

export type HotTopicsMode = "off" | "dry" | "live";
export type PostKind = "news" | "calendar";

export function parseMode(v: string | null | undefined): HotTopicsMode {
  const m = (v ?? "").trim().toLowerCase();
  return m === "dry" || m === "live" ? m : "off";
}

export function parseCap(v: string | null | undefined): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 && n <= 14 ? n : DEFAULT_WEEKLY_CAP;
}

interface RecentTopic { title: string; at: number; draftId: number; kind?: PostKind }

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

/** Calendar posts repeat only by exact key, after `CALENDAR_REPEAT_SEC`. */
export function isRecentCalendar(key: string, recent: RecentTopic[], nowSec: number): boolean {
  return recent.some((r) => r.title === key && nowSec - r.at < CALENDAR_REPEAT_SEC);
}

/** Which kind goes first: the one not yet used in the last 7 days (news by default). */
export function kindOrder(recent: RecentTopic[], nowSec: number): PostKind[] {
  const weekKinds = new Set(recent.filter((r) => nowSec - r.at < WEEK_SEC).map((r) => r.kind));
  if (weekKinds.has("news") && !weekKinds.has("calendar")) return ["calendar", "news"];
  return ["news", "calendar"];
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
    kind: PostKind;
    topic: string;
    source: string;
    sourceUrl?: string;
    subject?: string;
    category: string;
    divisive: number;
    factLine: string;
    question: string;
    caption: string;
    why: string;
    flags: string[];
    expiresAt: number;
    cardFontSize: number;
    cardLines: string[];
    imageUrl?: string;
    draftId?: number;
  };
  /** Other valid proposals from the same run (dry-run review). */
  alternatives?: Array<{ kind: PostKind; topic: string; factLine: string; question: string; caption: string }>;
}

/** A calendar post as a HotTopicPost (same shape the rest of the pipeline uses). */
function calendarAsPost(c: ReturnType<typeof calendarPosts>[number]): HotTopicPost | null {
  // Same validator as the LLM posts: a calendar text that fails it is a bug in the bank — never ship it.
  if (checkPostText(c)) return null;
  return {
    kind: "calendar", topicKey: `calendrier:${c.id}`, source: "calendrier", sourceTitle: c.sourceNote,
    category: c.category, divisive: 3, factLine: c.factLine, question: c.question, caption: c.caption,
    why: c.sourceNote, flags: [], trending: false, expiresAt: c.expiresAt,
  };
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

  const recent = await readRecent();
  const order = kindOrder(recent, nowSec);

  const calendar = calendarPosts(now)
    .map(calendarAsPost)
    .filter((p): p is HotTopicPost => p !== null && !isRecentCalendar(p.topicKey, recent, nowSec));

  let news: HotTopicPost[] = [];
  const base: HotTopicsResult = { mode };
  // The news side costs an LLM call: in live mode only run it when it can actually be the choice.
  const needNews = mode === "dry" || order[0] === "news" || calendar.length === 0;
  if (needNews) {
    const { candidates, feeds } = await collectCandidates(undefined, now);
    base.feeds = feeds;
    base.candidates = candidates.length;
    if (candidates.length > 0) {
      const outcome = await generateHotTopicPosts(candidates, now);
      base.blockedBeforeLlm = outcome.blockedBeforeLlm;
      base.rejected = outcome.rejected;
      news = rankPosts(outcome.posts.filter((p) => !isRecentDuplicate(p.topicKey, recent, nowSec)));
    }
  }

  const byKind: Record<PostKind, HotTopicPost[]> = { news, calendar };
  const ranked = order.flatMap((k) => byKind[k]);
  if (ranked.length === 0) {
    const result = { ...base, skipped: "aucun sujet sûr, connu et nouveau aujourd'hui" };
    await recordLastRun(result, nowSec);
    return result;
  }

  const best = ranked[0];
  const { png, layout } = await renderCardPng(best.factLine, best.question);
  const chosen: NonNullable<HotTopicsResult["chosen"]> = {
    kind: best.kind, topic: best.sourceTitle, source: best.source, ...(best.sourceUrl ? { sourceUrl: best.sourceUrl } : {}),
    ...(best.subject ? { subject: best.subject } : {}), category: best.category, divisive: best.divisive,
    factLine: best.factLine, question: best.question, caption: best.caption, why: best.why, flags: best.flags,
    expiresAt: best.expiresAt, cardFontSize: layout.fontSize, cardLines: [...layout.factLines, "", ...layout.lines],
  };
  const alternatives = ranked.slice(1).map((p) => ({
    kind: p.kind, topic: p.sourceTitle, factLine: p.factLine, question: p.question, caption: p.caption,
  }));

  if (mode === "dry") {
    const result = { ...base, chosen, alternatives };
    await recordLastRun(result, nowSec);
    return result;
  }

  // live — store the card, create ONE draft in status 'draft' (human approval required).
  const sku = await getAnyProductSku();
  if (!sku) throw new Error("hot-topics: catalogue vide — aucun SKU de remplacement pour le brouillon éditorial");
  const imageUrl = await uploadCardPng(png, best.subject ?? best.topicKey);
  const draftId = await createFacebookDraft({
    sku, triggerType: "hot_topic", language: "fr", postText: best.caption,
    imageUrl, imageUrls: [imageUrl],
    topicMeta: {
      kind: best.kind, topicKey: best.topicKey, source: best.source, sourceTitle: best.sourceTitle,
      sourceUrl: best.sourceUrl ?? null, sourcePublished: best.sourcePublished ?? null, subject: best.subject ?? null,
      category: best.category, factLine: best.factLine, question: best.question, why: best.why,
      flags: best.flags, trending: best.trending, expiresAt: best.expiresAt,
    },
  });
  chosen.imageUrl = imageUrl;
  chosen.draftId = draftId;

  const updated: RecentTopic[] = [{ title: best.topicKey, at: nowSec, draftId, kind: best.kind }, ...recent].slice(0, RECENT_KEEP);
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
