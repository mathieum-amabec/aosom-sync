import crypto from "crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/config";

// Two sequential blog generations (Claude article + 3 Unsplash searches +
// Shopify draft create), each ~30-50s, with a 3s pause between them.
export const maxDuration = 180;

// Spacing between FR and EN generations — stays well inside the blog/generate
// rate limiter (6/min) and gives Claude/Unsplash a beat.
const BETWEEN_LANGS_DELAY_MS = 3_000;

type Language = "fr" | "en";

type LangOutcome =
  | { language: Language; success: true; articleId: string; adminUrl: string; title: string }
  | { language: Language; success: false; error: string };

// Topic rotation keyed by ISO week number modulo 10 — same index FR/EN so
// the two articles in a single run share a theme.
const TOPICS_FR: readonly string[] = [
  "Guide entretien meubles bois intérieur",
  "Aménager un balcon urbain petit budget",
  "Meubles multifonctionnels petits espaces",
  "Décoration scandinave guide complet",
  "Comment choisir un canapé durable",
  "Tendances déco automne 2026 Québec",
  "Organiser son espace de travail à domicile",
  "Meubles écologiques et durables",
  "Créer une chambre cocooning",
  "Salle à manger conviviale nos conseils",
];

const TOPICS_EN: readonly string[] = [
  "How to arrange furniture in a small living room",
  "Best materials for outdoor furniture in Canada",
  "Home office setup for remote work productivity",
  "Mid-century modern furniture guide",
  "Choosing the right dining table for your family",
  "Fall decor trends 2026 Canadian homes",
  "Minimalist bedroom design tips",
  "Pet-friendly furniture materials ranked",
  "Creating a cozy reading nook",
  "Storage solutions for small apartments",
];

// Stopwords stripped when deriving keywords from a topic. Kept inline (small,
// language-specific to this file) to avoid a global stopword list module.
const STOP_FR = new Set([
  "le", "la", "les", "un", "une", "de", "du", "des", "d", "et", "à", "au", "aux",
  "en", "avec", "pour", "sur", "dans", "par", "ou", "ce", "ces", "son", "sa",
  "ses", "nos", "votre", "notre", "comment", "guide", "complet", "conseils",
  "est", "sont", "plus", "mieux", "tout", "tous", "toute", "toutes",
]);

const STOP_EN = new Set([
  "a", "an", "the", "of", "in", "on", "for", "to", "and", "or", "with", "by",
  "how", "best", "guide", "tips", "your", "you", "is", "are", "what", "when",
  "where", "which", "that", "this", "these", "those", "at", "from", "right",
  "into",
]);

function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  const expected = `Bearer ${env.cronSecret}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

function isoWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

function extractKeywords(topic: string, lang: Language): string[] {
  const stops = lang === "fr" ? STOP_FR : STOP_EN;
  return topic
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stops.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i)
    .slice(0, 3);
}

interface BlogGenerateResponse {
  success: true;
  articleId: string;
  adminUrl: string;
  title: string;
  handle: string;
  blogId: number;
}

async function generateBlog(
  origin: string,
  topic: string,
  lang: Language,
  keywords: string[],
): Promise<LangOutcome> {
  const url = `${origin}/api/blog/generate`;
  const tag = lang.toUpperCase();

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.cronSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ topic, lang, keywords }),
    });
  } catch (err) {
    console.error(`[CRON/blog] ${tag} fetch threw:`, err);
    return { language: lang, success: false, error: "Generate endpoint unreachable" };
  }

  if (!res.ok) {
    const text = await res.text();
    console.error(`[CRON/blog] ${tag} generation failed (HTTP ${res.status}):`, text);
    return { language: lang, success: false, error: `Generation failed (HTTP ${res.status})` };
  }

  const result = (await res.json()) as BlogGenerateResponse;
  console.log(`[CRON/blog] ${tag} article created: ${result.articleId} (${result.title})`);
  return {
    language: lang,
    success: true,
    articleId: result.articleId,
    adminUrl: result.adminUrl,
    title: result.title,
  };
}

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const week = isoWeekNumber(new Date());
  const idx = week % TOPICS_FR.length;
  const topicFr = TOPICS_FR[idx];
  const topicEn = TOPICS_EN[idx];
  const kwFr = extractKeywords(topicFr, "fr");
  const kwEn = extractKeywords(topicEn, "en");

  const origin = new URL(request.url).origin;

  console.log(`[CRON/blog] week=${week} idx=${idx} FR="${topicFr}" EN="${topicEn}"`);

  const fr = await generateBlog(origin, topicFr, "fr", kwFr);

  console.log(`[CRON/blog] Waiting ${BETWEEN_LANGS_DELAY_MS}ms before EN`);
  await new Promise((r) => setTimeout(r, BETWEEN_LANGS_DELAY_MS));

  const en = await generateBlog(origin, topicEn, "en", kwEn);

  const articles: LangOutcome[] = [fr, en];
  const generated = articles.filter((a) => a.success).length;
  console.log(`[CRON/blog] Complete — ${generated}/2 articles created`);

  const allFailed = generated === 0;
  return NextResponse.json(
    {
      success: !allFailed,
      week,
      topicIndex: idx,
      articles,
      generated,
      triggeredAt: new Date().toISOString(),
    },
    { status: allFailed ? 500 : 200 },
  );
}
