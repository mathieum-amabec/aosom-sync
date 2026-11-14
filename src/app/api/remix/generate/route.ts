import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { REMIX_THEMES, generateAndQueueRemix } from "@/lib/slideshow/remix";
import type { SlideshowRatio, SlideshowLanguage } from "@/lib/slideshow/types";

/**
 * POST /api/remix/generate
 *
 * Renders one themed remix compilation (Module F — recombines already-rendered
 * demand-gen clips, no re-render from source) and queues it as a `draft` video
 * in `publication_queue`. Draft = awaits human approval in /videos, exactly like
 * every other video the dashboard produces. This route NEVER auto-schedules or
 * publishes.
 *
 * Body: { theme: RemixTheme, ratio?: "9:16"|"1:1"|"16:9", language?: "fr"|"en",
 *         max_clips?: number, duration_filter?: "6s"|"15s"|"30s" }
 *
 * Admin-only (reviewers are read-only, same gate as every other queue-writing route).
 */
export const maxDuration = 540; // renderRemix's own timeout is 8min; leave margin under Vercel Pro's 800s ceiling

interface Body {
  theme?: string;
  ratio?: string;
  language?: string;
  max_clips?: number;
  duration_filter?: string;
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((await getSessionRole()) === "reviewer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const theme = typeof body.theme === "string" ? body.theme : "";
  if (!(REMIX_THEMES as string[]).includes(theme)) {
    return NextResponse.json({ error: `\`theme\` must be one of: ${REMIX_THEMES.join(", ")}` }, { status: 400 });
  }

  try {
    const result = await generateAndQueueRemix({
      theme,
      ratio: (typeof body.ratio === "string" ? body.ratio : undefined) as SlideshowRatio | undefined,
      language: (typeof body.language === "string" ? body.language : undefined) as SlideshowLanguage | undefined,
      maxClips: body.max_clips,
      durationFilter: body.duration_filter as "6s" | "15s" | "30s" | undefined,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("[API] POST /api/remix/generate failed:", err);
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
