/**
 * POST /api/social/content/generate — generate one content_template draft.
 *
 * Thin wrapper. Every piece of generation logic lives in
 * `lib/content-template-generator.ts` so `/api/cron/content` can call it
 * IN-PROCESS instead of `fetch()`ing this route: Vercel Cron invokes a function
 * on the *deployment* URL, which SSO Deployment Protection guards, so the old
 * self-call was answered 401 at the edge before this handler's own CRON_SECRET
 * check ran. See the note at the top of that lib for the full story.
 *
 * This route remains the operator-facing / server-to-server entry point. Its job
 * is auth, rate limiting, input validation, and mapping generation errors to
 * status codes.
 *
 * The path prefix `/api/social/content` is in proxy.ts PUBLIC_PATHS (so a
 * server-to-server caller with no session cookie is not 307'd to /login), which
 * makes the checks below the ONLY gate in front of paid Anthropic work.
 */

import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limiter";
import {
  generateContentTemplateDraft,
  ContentGenerationError,
} from "@/lib/content-template-generator";

export async function POST(request: Request) {
  try {
    const isCronAuth = verifyCronSecret(request.headers.get("authorization"));

    if (!isCronAuth) {
      if (!(await isAuthenticated())) {
        return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
      }
      if ((await getSessionRole()) === "reviewer") {
        return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
      }
    }

    // Per-process burst cap before Anthropic billing escalates. The global daily
    // token budget in budgetedCreate() is the cross-instance financial backstop;
    // this bounds a single instance's rate.
    const rl = checkRateLimit("social-content-generate", 10, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const { templateSlug, language = "fr" } = body as {
      templateSlug?: unknown;
      language?: unknown;
    };

    if (!templateSlug || typeof templateSlug !== "string") {
      return NextResponse.json(
        { success: false, error: "templateSlug is required" },
        { status: 400 },
      );
    }

    if (language !== "fr" && language !== "en") {
      return NextResponse.json(
        { success: false, error: "language must be 'fr' or 'en'" },
        { status: 400 },
      );
    }

    const result = await generateContentTemplateDraft(templateSlug, language);

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof ContentGenerationError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    console.error("[API] /api/social/content/generate POST failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
