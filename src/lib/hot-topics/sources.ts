/**
 * Topic discovery for "sujet chaud" posts — free public RSS feeds only, no API key.
 *
 * Sources (each one optional: a dead feed is logged and skipped, never fatal):
 *   - Google Trends "Daily Search Trends" for Québec — what people are searching right now, with the
 *     news headlines that explain each trend.
 *   - La Presse Sports and Le Journal de Montréal Sports — the local sports desk, where the Canadien
 *     stories live.
 * Google News RSS is deliberately NOT used: its feed terms limit it to personal feed readers.
 *
 * We only ever take a headline as *inspiration* for an original question. Nothing from an article is
 * republished, so there is no copyright surface and no link to a publisher in the post.
 */

export interface TopicCandidate {
  /** The headline / trend, as published. */
  title: string;
  /** Feed id — shown in the audit trail. */
  source: string;
  /** Optional context: the news headlines Google Trends attaches to a trend. */
  context?: string[];
  /** Rough popularity ("500+") for trends, when the feed gives it. */
  traffic?: string;
}

export interface FeedDef {
  id: string;
  url: string;
  kind: "trends" | "rss";
  /** Max items taken from this feed. */
  limit: number;
}

export const HOT_TOPIC_FEEDS: FeedDef[] = [
  { id: "google-trends-qc", url: "https://trends.google.com/trending/rss?geo=CA-QC", kind: "trends", limit: 20 },
  { id: "lapresse-sports", url: "https://www.lapresse.ca/sports/rss", kind: "rss", limit: 12 },
  { id: "jdm-sports", url: "https://www.journaldemontreal.com/sports/rss.xml", kind: "rss", limit: 12 },
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

/** Parse a plain RSS 2.0 headline feed. Exported for unit tests. */
export function parseHeadlineRss(xml: string, source: string, limit: number): TopicCandidate[] {
  const out: TopicCandidate[] = [];
  for (const block of items(xml)) {
    const title = firstTag(block, "title");
    if (!title || title.length < 12) continue;
    out.push({ title, source });
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchFeed(feed: FeedDef): Promise<TopicCandidate[]> {
  const res = await fetch(feed.url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AmeubloBot/1.0)", Accept: "application/rss+xml, application/xml, text/xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return feed.kind === "trends"
    ? parseTrendsRss(xml, feed.id, feed.limit)
    : parseHeadlineRss(xml, feed.id, feed.limit);
}

export interface CollectResult {
  candidates: TopicCandidate[];
  /** Per-feed outcome for the audit trail ("ok:20" / "error:HTTP 503"). */
  feeds: Record<string, string>;
}

/** Collect candidates from every feed; one feed failing never fails the run. De-duplicated by title. */
export async function collectCandidates(feeds: FeedDef[] = HOT_TOPIC_FEEDS): Promise<CollectResult> {
  const settled = await Promise.allSettled(feeds.map((f) => fetchFeed(f)));
  const candidates: TopicCandidate[] = [];
  const seen = new Set<string>();
  const status: Record<string, string> = {};
  settled.forEach((r, i) => {
    const id = feeds[i].id;
    if (r.status === "rejected") {
      status[id] = `error:${r.reason instanceof Error ? r.reason.message : String(r.reason)}`;
      console.warn(`[hot-topics] feed ${id} failed:`, r.reason);
      return;
    }
    status[id] = `ok:${r.value.length}`;
    for (const c of r.value) {
      const key = c.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(c);
    }
  });
  return { candidates, feeds: status };
}
