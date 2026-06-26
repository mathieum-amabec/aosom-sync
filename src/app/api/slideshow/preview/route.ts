import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSetting } from "@/lib/database";
import { parseSlideshowSettings } from "@/lib/publication-scheduler";
import { buildSlideshow, isSlideshowTemplate, languageForBrand, type BuildSlideshowOptions } from "@/lib/slideshow/build";
import {
  SlideshowTemplate,
  type SlideshowBrand,
  type SlideshowRatio,
  type SlideshowLanguage,
} from "@/lib/slideshow/types";

/**
 * GET /api/slideshow/preview?template=BEST_SELLERS&ratio=9:16&brand=ameublo&language=fr&...
 *
 * Returns the dry-run manifest for the requested template (no Blob write, no ffmpeg).
 * Optional knobs mirror BuildSlideshowOptions: ratio, brand, language, limit, sku,
 * category, sort, minPct, threshold, strategy, theme, title.
 *
 * Admin-only (same auth gate as generation).
 */
export async function GET(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const q = url.searchParams;
  const templateParam = q.get("template");
  if (!isSlideshowTemplate(templateParam)) {
    return NextResponse.json(
      { error: `\`template\` must be one of ${Object.values(SlideshowTemplate).join(", ")}` },
      { status: 400 },
    );
  }
  const template = templateParam;

  const settings = parseSlideshowSettings(await getSetting("slideshow_settings"));
  const brand = (q.get("brand") === "furnish" ? "furnish" : "ameublo") as SlideshowBrand;
  const ratio = (q.get("ratio") ?? settings.default_ratio) as SlideshowRatio;
  const langParam = q.get("language");
  const language: SlideshowLanguage = langParam === "en" || langParam === "fr" ? langParam : languageForBrand(brand);

  const num = (key: string): number | undefined => {
    const v = q.get(key);
    if (v === null || v.trim() === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const opts: BuildSlideshowOptions = {
    ratio,
    brand,
    language,
    dryRun: true,
    limit: num("limit"),
    sku: q.get("sku") ?? undefined,
    category: q.get("category") ?? undefined,
    sort: (q.get("sort") as BuildSlideshowOptions["sort"]) ?? undefined,
    minPct: num("minPct"),
    threshold: num("threshold"),
    strategy: (q.get("strategy") as BuildSlideshowOptions["strategy"]) ?? undefined,
    theme: q.get("theme") ?? undefined,
    title: q.get("title") ?? undefined,
  };

  try {
    const built = await buildSlideshow(template, opts);
    return NextResponse.json({ success: true, dryRun: true, manifest: built.result.manifest });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
