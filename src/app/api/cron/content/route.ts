import crypto from "crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/config";
import { selectRandomTemplate } from "@/lib/content-template-selector";

// Two sequential Claude calls (FR then EN), each with a 45s timeout, plus the
// rate-limit pause between them — give the function room beyond the old 60s.
export const maxDuration = 120;

// Spacing between the two Anthropic-backed generate calls.
const RATE_LIMIT_DELAY_MS = 2_000;

type Language = "fr" | "en";

type LangOutcome =
  | { language: Language; success: true; draftId: number; hookId: number | null }
  | { language: Language; success: false; error: string };

function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  const expected = `Bearer ${env.cronSecret}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/**
 * Generate one content draft in a single language by calling the generate
 * endpoint. Never throws — a failure is returned as a LangOutcome so the
 * caller can still attempt the other language.
 */
async function generateDraft(
  origin: string,
  templateSlug: string,
  language: Language,
): Promise<LangOutcome> {
  const generateUrl = `${origin}/api/social/content/generate`;
  const tag = language.toUpperCase();

  let res: Response;
  try {
    res = await fetch(generateUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.cronSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ templateSlug, language }),
    });
  } catch (err) {
    console.error(`[CRON] ${tag} fetch to /api/social/content/generate threw:`, err);
    return { language, success: false, error: "Generate endpoint unreachable" };
  }

  if (!res.ok) {
    const text = await res.text();
    console.error(`[CRON] ${tag} content generation failed for template ${templateSlug}:`, text);
    return { language, success: false, error: `Generation failed (HTTP ${res.status})` };
  }

  const result = (await res.json()) as { draftId: number; hookId: number | null };
  console.log(`[CRON] ${tag} draft created: ${result.draftId}`);
  return { language, success: true, draftId: result.draftId, hookId: result.hookId };
}

/**
 * Cron handler — generates one FR + one EN content draft per run.
 * On Mon/Wed/Fri that yields 6 drafts/week. Both languages use the same
 * template so the run produces a coherent bilingual pair on one topic.
 * Protected by CRON_SECRET header.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const template = await selectRandomTemplate();
  if (!template) {
    return NextResponse.json({ success: false, error: "No active templates" }, { status: 503 });
  }

  // Vercel crons send real HTTP requests, so request.url has the correct production origin.
  // VERCEL_URL is a deployment-specific preview URL (not the production alias) — do not use it.
  const origin = new URL(request.url).origin;

  console.log(`[CRON] Starting bilingual generation (FR+EN) for template '${template.slug}'`);

  // FR first. A FR failure does not abort the run — EN is still attempted.
  const fr = await generateDraft(origin, template.slug, "fr");

  // Space the two Anthropic calls to respect the rate limit.
  console.log(`[CRON] Waiting ${RATE_LIMIT_DELAY_MS}ms for rate limit`);
  await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS));

  const en = await generateDraft(origin, template.slug, "en");

  const drafts: LangOutcome[] = [fr, en];
  const generated = drafts.filter((d) => d.success).length;
  console.log(`[CRON] Bilingual generation complete — ${generated}/2 drafts created`);

  // Both languages failed → 500. Full or partial success → 200 with per-language detail.
  const allFailed = generated === 0;
  return NextResponse.json(
    {
      success: !allFailed,
      template: template.slug,
      contentType: template.content_type,
      drafts,
      generated,
      triggeredAt: new Date().toISOString(),
    },
    { status: allFailed ? 500 : 200 },
  );
}
