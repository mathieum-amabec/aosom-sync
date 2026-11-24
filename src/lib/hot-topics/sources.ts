/**
 * Topic discovery for "sujet chaud" posts — free public RSS feeds and the public NHL API, no API key.
 *
 * Sources (each one optional: a dead feed is logged and skipped, never fatal):
 *   - Local newsrooms (RSS): Journal de Montréal (hockey, sports, spectacles) and La Presse (sports,
 *     hockey, arts) — the stories Quebecers actually talk about. Every item must carry a publication
 *     date and be recent (see `maxAgeHours`): an undated or stale headline is dropped.
 *   - The NHL API (`nhl.ts`): the score of the Canadiens' last game — a hard fact, not an opinion.
 *   - Google Trends QC: NOT a topic source any more (10 keywords, often American). It is only a
 *     popularity marker: a headline that matches a trending search gets `trending: true`.
 * Google News RSS is deliberately NOT used: its feed terms limit it to personal feed readers.
 *
 * We only ever take a headline as *inspiration* for an original question. Nothing from an article is
 * republished, and the post does not link to a publisher.
 */
import { fetchMtlFacts } from "./nhl";

export interface TopicCandidate {
  /** The headline / fact, as published. */
  title: string;
  /** Feed id — shown in the audit trail. */
  source: string;
  /** "news" = a headline; "fact" = a number from an official API. */
  kind?: "news" | "fact";
  /** Supporting text: the article summary, or the fact details. The model may only use this + the title. */
  context?: string[];
  /** Rough popularity ("500+") for trends, when the feed gives it. */
  traffic?: string;
  /** Publication time, unix seconds. Candidates without one never reach the model. */
  published?: number;
  /** Unix seconds after which a post built on this must not be published (default: published + 48 h). */
  expires?: number;
  /** Source article URL — kept with the draft so the approver can read the story. */
  url?: string;
  /** True when the headline matches a current Google Trends search. */
  trending?: boolean;
  /** How many OTHER fresh headlines (any outlet) cover the same name — the "everyone is talking about it" signal. */
  buzz?: number;
}

export interface FeedDef {
  id: string;
  url: string;
  kind: "trends" | "rss";
  /** Max items taken from this feed. */
  limit: number;
  /** Items older than this are dropped (RSS feeds only). */
  maxAgeHours?: number;
}

export const HOT_TOPIC_FEEDS: FeedDef[] = [
  { id: "google-trends-qc", url: "https://trends.google.com/trending/rss?geo=CA-QC", kind: "trends", limit: 20 },
  { id: "jdm-hockey", url: "https://www.journaldemontreal.com/sports/hockey/rss.xml", kind: "rss", limit: 15, maxAgeHours: 30 },
  { id: "jdm-sports", url: "https://www.journaldemontreal.com/sports/rss.xml", kind: "rss", limit: 12, maxAgeHours: 30 },
  { id: "lapresse-hockey", url: "https://www.lapresse.ca/sports/hockey/rss", kind: "rss", limit: 12, maxAgeHours: 30 },
  { id: "lapresse-sports", url: "https://www.lapresse.ca/sports/rss", kind: "rss", limit: 12, maxAgeHours: 30 },
  { id: "jdm-spectacles", url: "https://www.journaldemontreal.com/spectacles/rss.xml", kind: "rss", limit: 12, maxAgeHours: 48 },
  { id: "lapresse-arts", url: "https://www.lapresse.ca/arts/rss", kind: "rss", limit: 10, maxAgeHours: 48 },
];

const FETCH_TIMEOUT_MS = 12_000;

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&nbsp;": " ",
};

/** Decode CDATA wrappers + the XML/HTML entities these feeds actually use. */
export function decodeXmlText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function firstTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeXmlText(m[1]) : null;
}

function allTags(block: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) out.push(decodeXmlText(m[1]));
  return out;
}

function items(xml: string): string[] {
  return xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
}

/** RFC-822 / ISO date → unix seconds, or undefined when it cannot be read. */
export function parsePubDate(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/** Strip tags from an RSS description and keep it short. */
function plainSummary(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const text = decodeXmlText(raw.replace(/<[^>]*>/g, " ")).slice(0, 280).trim();
  return text.length >= 20 ? text : undefined;
}

/** Parse a Google Trends RSS document. Exported for unit tests. */
export function parseTrendsRss(xml: string, source: string, limit: number): TopicCandidate[] {
  const out: TopicCandidate[] = [];
  for (const block of items(xml)) {
    const title = firstTag(block, "title");
    if (!title) continue;
    const context = allTags(block, "ht:news_item_title").slice(0, 3);
    const traffic = firstTag(block, "ht:approx_traffic") ?? undefined;
    out.push({ title, source, ...(context.length ? { context } : {}), ...(traffic ? { traffic } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Parse a plain RSS 2.0 headline feed. With `opts.maxAgeHours`, items without a readable date or
 * older than the window are dropped (a stale headline must never become "today's hot topic").
 * Exported for unit tests.
 */
export function parseHeadlineRss(
  xml: string,
  source: string,
  limit: number,
  opts: { now?: Date; maxAgeHours?: number } = {},
): TopicCandidate[] {
  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const out: TopicCandidate[] = [];
  for (const block of items(xml)) {
    const title = firstTag(block, "title");
    if (!title || title.length < 12) continue;
    const published = parsePubDate(firstTag(block, "pubDate") ?? firstTag(block, "dc:date"));
    if (opts.maxAgeHours !== undefined) {
      if (published === undefined) continue;
      const ageH = (nowSec - published) / 3600;
      if (ageH > opts.maxAgeHours || ageH < -2) continue;
    }
    const summary = plainSummary(firstTag(block, "description"));
    const url = firstTag(block, "link") ?? undefined;
    out.push({
      title, source, kind: "news",
      ...(published !== undefined ? { published } : {}),
      ...(url && /^https?:\/\//.test(url) ? { url } : {}),
      ...(summary && summary !== title ? { context: [summary] } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function tokenSet(s: string): Set<string> {
  return new Set(
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2),
  );
}

/**
 * Flag the candidates whose headline matches a current trending search (every word of the trend
 * appears in the headline; a one-word trend must be ≥5 letters). Popularity only — never a source.
 */
export function markTrending(candidates: TopicCandidate[], trendTitles: string[]): void {
  const trends = trendTitles.map(tokenSet).filter((t) => t.size >= 2 || [...t].some((w) => w.length >= 5));
  if (trends.length === 0) return;
  for (const c of candidates) {
    const toks = tokenSet(c.title);
    if (trends.some((t) => t.size > 0 && [...t].every((w) => toks.has(w)))) c.trending = true;
  }
}

/** Words too common in Québec sports/news headlines to identify a story. */
const BUZZ_STOPWORDS = new Set([
  "canadien", "canadiens", "montreal", "quebec", "hockey", "match", "matchs", "saison", "joueur", "joueurs", "equipe",
  "apres", "contre", "entre", "avec", "dans", "cette", "selon", "depuis", "encore", "avant", "notre", "leurs", "faire",
  "centre", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche", "ligue", "partie", "soiree", "haut",
  "premier", "premiere", "nouveau", "nouvelle", "grand", "grande", "tout", "tous", "toute", "toutes", "rondelle", "critique",
]);

/**
 * Cross-source signal: for each headline, how many OTHER headlines share its most-shared distinctive
 * word (a player, a team, a show). A name that 12 headlines carry is what people are actually talking
 * about; a one-off is not. Words in 3–25 headlines only (rarer = noise, more common = generic).
 */
export function markBuzz(candidates: TopicCandidate[]): void {
  const df = new Map<string, number>();
  const toks = candidates.map((c) => [...tokenSet(c.title)].filter((w) => w.length >= 5 && !BUZZ_STOPWORDS.has(w)));
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  candidates.forEach((c, i) => {
    let best = 0;
    for (const w of toks[i]) {
      const n = df.get(w) ?? 0;
      if (n >= 3 && n <= 25) best = Math.max(best, n - 1);
    }
    if (best > 0) c.buzz = best;
  });
}

async function fetchFeedXml(feed: FeedDef): Promise<string> {
  const res = await fetch(feed.url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AmeubloBot/1.0)", Accept: "application/rss+xml, application/xml, text/xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export interface CollectResult {
  candidates: TopicCandidate[];
  /** Per-feed outcome for the audit trail ("ok:20" / "error:HTTP 503"). */
  feeds: Record<string, string>;
}

/**
 * Collect candidates from every source; one source failing never fails the run. Newest first,
 * de-duplicated by title. Google Trends only marks popularity; the NHL API adds one hard fact.
 */
export async function collectCandidates(feeds: FeedDef[] = HOT_TOPIC_FEEDS, now: Date = new Date()): Promise<CollectResult> {
  const jobs: Array<{ id: string; run: () => Promise<TopicCandidate[]> }> = feeds.map((f) => ({
    id: f.id,
    run: async () => {
      const xml = await fetchFeedXml(f);
      return f.kind === "trends"
        ? parseTrendsRss(xml, f.id, f.limit)
        : parseHeadlineRss(xml, f.id, f.limit, { now, maxAgeHours: f.maxAgeHours });
    },
  }));
  jobs.push({
    id: "nhl-api",
    run: () => fetchMtlFacts(now),
  });

  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  const status: Record<string, string> = {};
  const trendTitles: string[] = [];
  const candidates: TopicCandidate[] = [];
  const seen = new Set<string>();
  settled.forEach((r, i) => {
    const id = jobs[i].id;
    if (r.status === "rejected") {
      status[id] = `error:${r.reason instanceof Error ? r.reason.message : String(r.reason)}`;
      console.warn(`[hot-topics] source ${id} failed:`, r.reason);
      return;
    }
    status[id] = `ok:${r.value.length}`;
    if (feeds.find((f) => f.id === id)?.kind === "trends") {
      trendTitles.push(...r.value.map((c) => c.title));
      return;
    }
    for (const c of r.value) {
      const key = c.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(c);
    }
  });
  markTrending(candidates, trendTitles);
  markBuzz(candidates);
  // Facts first (they cannot be wrong), then the most-covered stories, then newest.
  candidates.sort((a, b) => Number(b.kind === "fact") - Number(a.kind === "fact") || (b.buzz ?? 0) - (a.buzz ?? 0) || (b.published ?? 0) - (a.published ?? 0));
  return { candidates, feeds: status };
}
