import { NextResponse } from "next/server";
import { isAuthenticated, isAdmin, getSession } from "@/lib/auth";
import { AUTOMATION_KEYS, getAutomationStatus, setAutomation, type AutomationKey } from "@/lib/automation-controls";
import type { AutoImportMode } from "@/lib/auto-import/policy";

/**
 * GET  /api/automations — state and recent work of the automatic jobs (import, publications, "La semaine").
 * POST /api/automations — { key: "auto_import" | "publisher" | "semaine" | "all", enabled: boolean, mode?: "off"|"dry"|"pilot"|"live" }.
 *
 * Admin-only to change anything. Every switch is a `settings` row read on the next cron tick, so a pause is
 * immediate and nothing queued is deleted. `all` flips the three switches together ("Tout arrêter").
 */
export const dynamic = "force-dynamic";

const MODES: readonly AutoImportMode[] = ["off", "dry", "pilot", "live"];

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!(await isAdmin())) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }
  try {
    return NextResponse.json({ success: true, data: await getAutomationStatus() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/automations failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!(await isAdmin())) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }
  let body: { key?: unknown; enabled?: unknown; mode?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 });
  }
  const { key, enabled, mode } = body;
  const keys: AutomationKey[] | null =
    key === "all" ? [...AUTOMATION_KEYS] : AUTOMATION_KEYS.includes(key as AutomationKey) ? [key as AutomationKey] : null;
  if (!keys || typeof enabled !== "boolean") {
    return NextResponse.json({ success: false, error: "key (auto_import|publisher|semaine|all) and enabled (boolean) are required" }, { status: 400 });
  }
  if (mode !== undefined && !MODES.includes(mode as AutoImportMode)) {
    return NextResponse.json({ success: false, error: "mode must be off, dry, pilot or live" }, { status: 400 });
  }
  try {
    const by = (await getSession())?.username ?? "admin";
    for (const k of keys) {
      await setAutomation(k, enabled, by, k === "auto_import" ? (mode as AutoImportMode | undefined) : undefined);
    }
    return NextResponse.json({ success: true, data: await getAutomationStatus() });
  } catch (err) {
    console.error("[API] POST /api/automations failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
