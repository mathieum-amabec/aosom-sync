import { NextResponse } from "next/server";
import { getAllSettings, setSetting } from "@/lib/database";
import { ALLOWED_SETTINGS_KEYS } from "@/lib/config";

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
      if (!ALLOWED_SETTINGS_KEYS.has(key)) continue;
      setSetting(key, value);
    }

    const settings = getAllSettings();
    return NextResponse.json({ success: true, data: settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
