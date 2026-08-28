/**
 * GET /api/cron/content — bilingual content-template generation (Vercel Cron, Mon/Wed/Fri 14:00 UTC).
 *
 * **GET, not POST, on purpose:** Vercel Cron only ever issues GET requests.
 *
 * Generation runs **in-process** via `generateContentTemplateDraft()`. This route
 * used to `fetch()` its own `/api/social/content/generate` endpoint. Vercel Cron
 * invokes the function on the *deployment* URL, and with SSO Deployment Protection
 * on and no custom domain the platform answered that self-call with a 401 before
 * the app's own CRON_SECRET check ran. Every run from 2026-07-29 to 2026-08-26
 * failed that way — 13 runs, 13 errors, zero drafts — while the generator itself
 * worked fine when called directly. `/api/cron/blog` hit the identical wall and was
 * moved in-process first; this route had not been given the same treatment.
 * See lib/content-template-generator.ts for the full note.
 */

import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { selectRandomTemplate } from "@/lib/content-template-selector";
import { trackCron } from "@/lib/cron-tracking";
import {
  generateContentTemplateDraft,
  type ContentLanguage,
} from "@/lib/content-template-generator";

// Both Claude calls now run inside THIS function rather than in a child route, so
// this budget has to cover them end to end: 2 generations (45s timeout each) + the
// rate-limit pause + 2 Unsplash lookups + the DB writes. 120s left no headroom once
// the work moved in here.
export const maxDuration = 300;

// Spacing between the two Anthropic-backed generate calls.
const RATE_LIMIT_DELAY_MS = 2_000;

type LangOutcome =
  | { language: ContentLanguage; success: true; draftId: number; hookId: number | null }
  | { language: ContentLanguage; success: false; error: string };

/**
 * Generate one content draft in a single language. Never throws — a failure is
 * returned as a LangOutcome so the caller can still attempt the other language.
 */
async function generateDraft(
  templateSlug: string,
  language: ContentLanguage,
): Promise<LangOutcome> {
  const tag = language.toUpperCase();
  try {
    const result = await generateContentTemplateDraft(templateSlug, language);
    console.log(`[CRON] ${tag} draft created: ${result.draftId}`);
    return { language, success: true, draftId: result.draftId, hookId: result.hookId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CRON] ${tag} content generation failed for template ${templateSlug}:`, msg);
    return { language, success: false, error: msg };
  }
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

  console.log(`[CRON] Starting bilingual generation (FR+EN) for template '${template.slug}'`);

  // trackCron records the run (success/error) in cron_runs for the dashboard. The
  // work throws on total failure so it is logged as 'error'; the outer catch turns
  // that back into the same 500 response shape the route returned before.
  let drafts: LangOutcome[] = [];
  try {
    const generated = await trackCron("content", async () => {
      // FR first. A FR failure does not abort the run — EN is still attempted.
      const fr = await generateDraft(template.slug, "fr");

      // Space the two Anthropic calls to respect the rate limit.
      console.log(`[CRON] Waiting ${RATE_LIMIT_DELAY_MS}ms for rate limit`);
      await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS));

      const en = await generateDraft(template.slug, "en");

      drafts = [fr, en];
      const count = drafts.filter((d) => d.success).length;
      console.log(`[CRON] Bilingual generation complete — ${count}/2 drafts created`);
      if (count === 0) {
        // Propagate each language's real failure into the thrown message so
        // trackCron records it in cron_runs.detail. Without this the dashboard
        // only ever shows the generic wrapper text and the actual cause stays
        // buried in Vercel function logs — which is exactly how the 401 on the
        // old self-fetch went unnoticed for four weeks.
        const detail = drafts
          .map((d) => `${d.language.toUpperCase()}: ${d.success ? "ok" : d.error}`)
          .join(" | ");
        throw new Error(`Both FR and EN content generations failed — ${detail}`);
      }
      return count;
    });

    return NextResponse.json(
      {
        success: true,
        template: template.slug,
        contentType: template.content_type,
        drafts,
        generated,
        triggeredAt: new Date().toISOString(),
      },
      { status: 200 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CRON/content] run failed:", msg);
    return NextResponse.json(
      {
        success: false,
        template: template.slug,
        contentType: template.content_type,
        drafts,
        generated: drafts.filter((d) => d.success).length,
        error: msg,
        triggeredAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
