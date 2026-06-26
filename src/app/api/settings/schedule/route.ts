import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/database";
import {
  parsePublicationSchedule,
  parseBlogSchedule,
  parseVideoSchedule,
  parseSlideshowSettings,
  normalizePublicationSchedule,
  normalizeBlogSchedule,
  normalizeVideoSchedule,
  normalizeSlideshowSettings,
} from "@/lib/publication-scheduler";

/**
 * GET /api/settings/schedule
 *
 * Returns the current publication + blog schedules, normalized (missing/invalid
 * values fall back to defaults).
 */
export async function GET() {
  try {
    const [pubRaw, blogRaw, videoRaw, slideshowRaw] = await Promise.all([
      getSetting("publication_schedule"),
      getSetting("blog_schedule"),
      getSetting("video_schedule"),
      getSetting("slideshow_settings"),
    ]);
    return NextResponse.json({
      success: true,
      data: {
        publication_schedule: parsePublicationSchedule(pubRaw),
        blog_schedule: parseBlogSchedule(blogRaw),
        video_schedule: parseVideoSchedule(videoRaw),
        slideshow_settings: parseSlideshowSettings(slideshowRaw),
      },
    });
  } catch (err) {
    console.error(`[API] /api/settings/schedule GET failed:`, err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

/**
 * PATCH /api/settings/schedule
 *
 * Body: { publication_schedule?: object, blog_schedule?: object }
 *
 * Each provided block is validated/normalized, then persisted as JSON. Returns
 * the resulting normalized schedules. Admin-only (reviewers cannot edit settings).
 */
export async function PATCH(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((await getSessionRole()) === "reviewer") {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ success: false, error: "Body must be an object" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  if (
    b.publication_schedule === undefined &&
    b.blog_schedule === undefined &&
    b.video_schedule === undefined &&
    b.slideshow_settings === undefined
  ) {
    return NextResponse.json(
      {
        success: false,
        error: "Provide `publication_schedule`, `blog_schedule`, `video_schedule`, and/or `slideshow_settings`",
      },
      { status: 400 },
    );
  }

  try {
    if (b.publication_schedule !== undefined) {
      const normalized = normalizePublicationSchedule(b.publication_schedule);
      await setSetting("publication_schedule", JSON.stringify(normalized));
    }
    if (b.blog_schedule !== undefined) {
      const normalized = normalizeBlogSchedule(b.blog_schedule);
      await setSetting("blog_schedule", JSON.stringify(normalized));
    }
    if (b.video_schedule !== undefined) {
      const normalized = normalizeVideoSchedule(b.video_schedule);
      await setSetting("video_schedule", JSON.stringify(normalized));
    }
    if (b.slideshow_settings !== undefined) {
      const normalized = normalizeSlideshowSettings(b.slideshow_settings);
      await setSetting("slideshow_settings", JSON.stringify(normalized));
    }

    const [pubRaw, blogRaw, videoRaw, slideshowRaw] = await Promise.all([
      getSetting("publication_schedule"),
      getSetting("blog_schedule"),
      getSetting("video_schedule"),
      getSetting("slideshow_settings"),
    ]);
    return NextResponse.json({
      success: true,
      data: {
        publication_schedule: parsePublicationSchedule(pubRaw),
        blog_schedule: parseBlogSchedule(blogRaw),
        video_schedule: parseVideoSchedule(videoRaw),
        slideshow_settings: parseSlideshowSettings(slideshowRaw),
      },
    });
  } catch (err) {
    console.error(`[API] /api/settings/schedule PATCH failed:`, err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
