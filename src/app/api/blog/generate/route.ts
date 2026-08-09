/**
 * POST /api/blog/generate
 *
 * Manual/admin entry point for one blog article. The generation itself lives in
 * `lib/blog-generator.ts` — the blog cron calls that directly in-process rather than coming
 * back through this route over HTTP (see the note in blog-generator.ts: the self-fetch was
 * being 401'd by Vercel SSO Deployment Protection before this handler ever ran).
 *
 * Request body:
 *   { topic: string, lang: "fr" | "en", keywords?: string[], images?: UnsplashImage[],
 *     season?: Season, autoPublish?: boolean }
 */

import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { isAuthenticated, isAdmin } from "@/lib/auth";
import { type UnsplashImage } from "@/lib/unsplash";
import { type BlogLang } from "@/lib/shopify-blog";
import { type Season } from "@/lib/blog-topics";
import { generateBlogArticle, type GenerateBlogInput } from "@/lib/blog-generator";
import { checkRateLimit } from "@/lib/rate-limiter";

// Claude article generation (~25-45s) + up to 3 Unsplash searches + download pings + the
// Shopify article create.
export const maxDuration = 120;

const IMAGE_FIELDS = [
  "id", "url", "altDescription", "photographer",
  "photographerUrl", "unsplashUrl", "downloadLocation",
] as const;

/**
 * Validate a caller-supplied image set. Malformed input returns `undefined` (ignored → the
 * generator falls back to its own search) rather than 400, so a bad `images` field never
 * blocks article creation.
 */
function parseImages(raw: unknown): UnsplashImage[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: UnsplashImage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (IMAGE_FIELDS.every((f) => typeof o[f] === "string")) {
      out.push({
        id: o.id as string,
        url: o.url as string,
        altDescription: o.altDescription as string,
        photographer: o.photographer as string,
        photographerUrl: o.photographerUrl as string,
        unsplashUrl: o.unsplashUrl as string,
        downloadLocation: o.downloadLocation as string,
      });
    }
  }
  return out.length > 0 ? out.slice(0, 6) : undefined;
}

function parseBody(raw: unknown): GenerateBlogInput | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Body must be a JSON object" };
  const obj = raw as Record<string, unknown>;

  const topic = typeof obj.topic === "string" ? obj.topic.trim() : "";
  if (!topic) return { error: "`topic` is required (non-empty string)" };
  if (topic.length > 200) return { error: "`topic` must be 200 chars or less" };

  const lang = obj.lang;
  if (lang !== "fr" && lang !== "en") {
    return { error: '`lang` must be "fr" or "en"' };
  }

  let keywords: string[] | undefined;
  if (obj.keywords !== undefined) {
    if (!Array.isArray(obj.keywords)) {
      return { error: "`keywords` must be an array of strings" };
    }
    keywords = obj.keywords
      .filter((k): k is string => typeof k === "string")
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 10);
  }

  const images = parseImages(obj.images);

  let season: Season | undefined;
  if (obj.season !== undefined) {
    const s = obj.season;
    if (s !== "spring" && s !== "summer" && s !== "fall" && s !== "winter" && s !== "all") {
      return { error: "`season` must be one of: spring, summer, fall, winter, all" };
    }
    season = s;
  }

  const autoPublish = obj.autoPublish === true;

  return { topic, lang: lang as BlogLang, keywords, images, season, autoPublish };
}

export async function POST(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    // Manual (session) generation is admin-only (P2-4): paid Anthropic spend must not be
    // reachable by a reviewer session. The server-to-server path keeps working unchanged.
    if (!(await isAuthenticated())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!(await isAdmin())) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Rate limit: 6 generations per minute per process (room for retries and bursts, hard cap
  // before Anthropic billing escalates). The cron no longer consumes this budget.
  const rl = checkRateLimit("blog-generate", 6, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseBody(raw);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const result = await generateBlogArticle(parsed);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    // Full upstream error (Shopify/Claude/Unsplash payloads, stack) goes to server logs only.
    // The client gets a generic message + a short code the admin UI can map to a friendly
    // string without exposing internals.
    console.error("[/api/blog/generate] failed:", err);
    const code = err instanceof Error && /^Shopify/i.test(err.message)
      ? "shopify_error"
      : err instanceof Error && /^Unsplash/i.test(err.message)
        ? "unsplash_error"
        : err instanceof Error && /Claude/i.test(err.message)
          ? "claude_error"
          : "internal_error";
    return NextResponse.json({ error: "Blog generation failed", code }, { status: 500 });
  }
}
