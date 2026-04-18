import { NextResponse } from "next/server";
import { getAllSettings, setSetting } from "@/lib/database";
import { ALLOWED_SETTINGS_KEYS } from "@/lib/config";
import { getSessionRole } from "@/lib/auth";

export async function GET() {
  try {
    const settings = await getAllSettings();
    return NextResponse.json({ success: true, data: settings });
  } catch (err) {
    console.error(`[API] /api/settings GET failed:`, err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    if ((await getSessionRole()) === "reviewer") {
      return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
    }
    const body = await request.json();
    const updates = body as Record<string, string>;

    for (const [key, value] of Object.entries(updates)) {
      if (typeof key !== "string" || typeof value !== "string") continue;
      if (!ALLOWED_SETTINGS_KEYS.has(key)) continue;
      // Limit value length to prevent abuse
      if (value.length > 5000) continue;
      await setSetting(key, value);
    }

    const settings = await getAllSettings();
    return NextResponse.json({ success: true, data: settings });
  } catch (err) {
    console.error(`[API] /api/settings PUT failed:`, err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
