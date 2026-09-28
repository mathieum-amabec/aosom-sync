import { NextResponse } from "next/server";
import { requireStudioAdmin } from "@/lib/studio/guard";
import { FORMATS, DURATIONS, TRANSITIONS } from "@/lib/studio/options";
import { listStudioTracks } from "@/lib/studio/music";
import { PRESETS, STAGE_SCENES, SEASONS, isAiRetouchConfigured } from "@/lib/studio/ai-retouch";
import { countAiImagesToday } from "@/lib/studio/db";
import { STUDIO_AI } from "@/lib/config";

/** GET /api/studio/options — every menu of the Studio page: transitions, formats, durations, music, AI presets. */
export async function GET() {
  const denied = await requireStudioAdmin();
  if (denied) return denied;
  try {
    const [tracks, aiUsedToday] = await Promise.all([
      listStudioTracks().catch((e) => {
        console.error("[API] studio music list failed:", e);
        return [];
      }),
      countAiImagesToday(),
    ]);
    return NextResponse.json({
      success: true,
      data: {
        transitions: TRANSITIONS.map(({ id, label, description }) => ({ id, label, description })),
        formats: Object.entries(FORMATS).map(([id, f]) => ({ id, label: f.label })),
        durations: DURATIONS,
        tracks,
        ai: {
          configured: isAiRetouchConfigured(),
          model: STUDIO_AI.IMAGE_MODEL,
          dailyCap: STUDIO_AI.DAILY_CAP,
          usedToday: aiUsedToday,
          presets: PRESETS,
          scenes: Object.keys(STAGE_SCENES),
          seasons: Object.keys(SEASONS),
        },
      },
    });
  } catch (err) {
    console.error("[API] /api/studio/options failed:", err);
    return NextResponse.json({ success: false, error: "Impossible de charger les options" }, { status: 500 });
  }
}
