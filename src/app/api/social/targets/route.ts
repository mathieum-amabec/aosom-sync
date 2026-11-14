import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getSetting, setSetting, getSocialTargetRows } from "@/lib/database";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { SYNC } from "@/lib/config";
import { getLifestyleVerifiedProductIds } from "@/lib/selectors/lifestyle-verified-set";
import { buildTargetTree } from "@/lib/social-targets";
import {
  parseThemes,
  validateProductTypes,
  validateThemeLabel,
  SOCIAL_THEMES_KEY,
  SOCIAL_AUTO_THEME_KEY,
  MAX_THEMES,
  type SocialTheme,
} from "@/lib/social-categories";

/**
 * GET /api/social/targets — the sub-category tree (with postable counts) + saved themes.
 * POST /api/social/targets — {action:"save", label, productTypes, id?} | {action:"delete", id}
 *                            | {action:"set-auto", id} (id "" = back to the seasonal default).
 *
 * Themes only change WHICH products drafts are generated for. Nothing here approves,
 * schedules or publishes anything.
 */
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const minDays = parseInt(
      (await getSetting("social_min_days_between_reposts")) || SYNC.DEFAULT_MIN_DAYS_BETWEEN_REPOSTS,
      10,
    );
    const cutoff = Math.floor(Date.now() / 1000) - minDays * 86400;
    const [rows, verified, rawThemes, autoThemeId] = await Promise.all([
      getSocialTargetRows(),
      getLifestyleVerifiedProductIds(),
      getSetting(SOCIAL_THEMES_KEY),
      getSetting(SOCIAL_AUTO_THEME_KEY),
    ]);
    return NextResponse.json({
      success: true,
      data: {
        nodes: buildTargetTree(rows, verified, cutoff),
        verifiedKnown: verified !== null,
        cooldownDays: minDays,
        themes: parseThemes(rawThemes),
        autoThemeId: autoThemeId || "",
      },
    });
  } catch (err) {
    console.error(`[API] /api/social/targets GET failed:`, err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((await getSessionRole()) === "reviewer") {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const themes = parseThemes(await getSetting(SOCIAL_THEMES_KEY));

    switch (body.action) {
      case "save": {
        const label = validateThemeLabel(body.label);
        const productTypes = validateProductTypes(body.productTypes);
        if (!label || !productTypes) {
          return NextResponse.json(
            { success: false, error: "Nom et au moins une sous-catégorie requis" },
            { status: 400 },
          );
        }
        const id = typeof body.id === "string" && body.id ? body.id : null;
        let next: SocialTheme[];
        if (id) {
          if (!themes.some((t) => t.id === id)) {
            return NextResponse.json({ success: false, error: "Thème introuvable" }, { status: 404 });
          }
          next = themes.map((t) => (t.id === id ? { id, label, productTypes } : t));
        } else {
          if (themes.length >= MAX_THEMES) {
            return NextResponse.json(
              { success: false, error: `Maximum ${MAX_THEMES} thèmes` },
              { status: 400 },
            );
          }
          next = [...themes, { id: randomUUID(), label, productTypes }];
        }
        await setSetting(SOCIAL_THEMES_KEY, JSON.stringify(next));
        return NextResponse.json({ success: true, data: next });
      }
      case "delete": {
        const id = typeof body.id === "string" ? body.id : "";
        const next = themes.filter((t) => t.id !== id);
        if (next.length === themes.length) {
          return NextResponse.json({ success: false, error: "Thème introuvable" }, { status: 404 });
        }
        await setSetting(SOCIAL_THEMES_KEY, JSON.stringify(next));
        // A deleted theme can't stay the daily preference.
        if ((await getSetting(SOCIAL_AUTO_THEME_KEY)) === id) await setSetting(SOCIAL_AUTO_THEME_KEY, "");
        return NextResponse.json({ success: true, data: next });
      }
      case "set-auto": {
        const id = typeof body.id === "string" ? body.id : "";
        if (id && !themes.some((t) => t.id === id)) {
          return NextResponse.json({ success: false, error: "Thème introuvable" }, { status: 404 });
        }
        await setSetting(SOCIAL_AUTO_THEME_KEY, id);
        return NextResponse.json({ success: true, data: { autoThemeId: id } });
      }
      default:
        return NextResponse.json({ success: false, error: "Action inconnue" }, { status: 400 });
    }
  } catch (err) {
    console.error(`[API] /api/social/targets POST failed:`, err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
