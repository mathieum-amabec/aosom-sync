import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { trackCron } from "@/lib/cron-tracking";
import { runSemaine } from "@/lib/semaine/run";
import type { SlotName } from "@/lib/semaine/types";

/**
 * "La semaine Ameublo": builds and queues ONE photo post per brand for the next slot.
 *   ?slot=morning|afternoon   (required)
 *   ?dryRun=1                 preview only: builds the post, queues nothing, ignores the kill switch
 *   ?force=1                  retry a slot that failed earlier today (a queued slot is never replaced)
 * Kill switch: setting `semaine_enabled` must be "1" (anything else = nothing is queued).
 * Protected by CRON_SECRET.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const q = new URL(request.url).searchParams;
  const slot = q.get("slot");
  if (slot !== "morning" && slot !== "afternoon") {
    return NextResponse.json({ success: false, error: "slot must be morning or afternoon" }, { status: 400 });
  }
  const dryRun = q.get("dryRun") === "1";
  try {
    const run = () => runSemaine({ slot: slot as SlotName, dryRun, force: q.get("force") === "1" });
    const result = dryRun ? await run() : await trackCron(`semaine-${slot}`, run, (r) => `${r.status}${r.format ? ` ${r.format}` : ""}${r.reason ? ` (${r.reason})` : ""}`);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CRON/semaine] failed:", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export const maxDuration = 300;
