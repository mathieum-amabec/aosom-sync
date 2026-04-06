import { NextResponse } from "next/server";
import { getAllSettings, setSetting } from "@/lib/database";

const ALLOWED_KEYS = new Set([
  "social_default_language", "social_post_frequency", "social_preferred_hour",
  "social_price_drop_threshold", "social_min_days_between_reposts",
  "social_hashtags_fr", "social_hashtags_en", "social_include_price",
  "social_include_link", "social_tone",
  "prompt_new_product_fr", "prompt_new_product_en",
  "prompt_price_drop_fr", "prompt_price_drop_en",
  "prompt_highlight_fr", "prompt_highlight_en",
]);

export async function GET() {
  try {
    const settings = getAllSettings();
    return NextResponse.json({ success: true, data: settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const updates = body as Record<string, string>;

    for (const [key, value] of Object.entries(updates)) {
      if (typeof key !== "string" || typeof value !== "string") continue;
      if (!ALLOWED_KEYS.has(key)) continue;
      setSetting(key, value);
    }

    const settings = getAllSettings();
    return NextResponse.json({ success: true, data: settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
