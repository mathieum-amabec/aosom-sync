import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { classifyAllImportJobs } from "@/lib/import-job-state-service";
import type { ImportJobState } from "@/lib/import-job-state";

/**
 * GET /api/import/state — the REAL state of every import job (Shopify live/hidden/archived/
 * deleted, Aosom in stock/out of stock/gone, and the page tab it belongs to). Separate from
 * /api/import/queue so the list renders immediately while this slower Shopify pass runs.
 */
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const classified = await classifyAllImportJobs();
    const states: Record<string, ImportJobState> = {};
    for (const c of classified) states[c.job.id] = c.state;
    return NextResponse.json({ success: true, data: states });
  } catch (err) {
    console.error("[API] /api/import/state failed:", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Vérification impossible" },
      { status: 500 },
    );
  }
}

export const maxDuration = 60;
