import { NextResponse } from "next/server";
import { queueForImport, getImportJobsList } from "@/lib/import-pipeline";
import { isAuthenticated } from "@/lib/auth";
import { IMPORT } from "@/lib/config";

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const jobs = await getImportJobsList();
  return NextResponse.json({ success: true, data: jobs });
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { skus } = await request.json();
    if (!Array.isArray(skus) || skus.length === 0) {
      return NextResponse.json({ success: false, error: "skus array required" }, { status: 400 });
    }
    // The cap is derived from what the route can actually finish inside
    // maxDuration, not picked by feel — see IMPORT in lib/config.ts. `code` lets
    // the client tell this apart from the other 400s and name the real number.
    if (skus.length > IMPORT.MAX_SKUS_PER_BATCH) {
      return NextResponse.json(
        {
          success: false,
          code: "batch_too_large",
          max: IMPORT.MAX_SKUS_PER_BATCH,
          received: skus.length,
          error: `Maximum ${IMPORT.MAX_SKUS_PER_BATCH} SKUs per batch`,
        },
        { status: 400 },
      );
    }
    // Validate each SKU is a non-empty string with max length
    const validSkus = skus.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 50);
    if (validSkus.length === 0) {
      return NextResponse.json({ success: false, error: "No valid SKUs provided" }, { status: 400 });
    }
    const jobs = await queueForImport(validSkus);
    return NextResponse.json({ success: true, data: jobs });
  } catch (err) {
    console.error(`[API] /api/import/queue failed:`, err);
    return NextResponse.json({ success: false, error: "Queue operation failed" }, { status: 500 });
  }
}

// Was 60 s, which only fit ~11 products once the pos-1 vision guard landed
// (2f24ff3) — every larger batch 504'd mid-loop. 300 s is within the Vercel plan
// ceiling (the Phase-1 sync function on this same project already runs at 800 s).
//
// MUST STAY A LITERAL. Route segment config is read by static analysis at build
// time; a computed or imported value is silently ignored (Next.js docs:
// "revalidate = 60 * 10 is not valid", matcher "dynamic values ... will be
// ignored"). Writing `= IMPORT.ROUTE_MAX_DURATION_S` here would look correct and
// quietly leave the route at the platform default — the same class of silent
// failure this whole fix is about.
//
// Keep it equal to IMPORT.ROUTE_MAX_DURATION_S in lib/config.ts;
// tests/import-batch-sizing.test.ts reads this file and fails if they drift.
export const maxDuration = 300;
