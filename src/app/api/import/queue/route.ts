import { NextResponse } from "next/server";
import { queueForImport, getImportJobsList } from "@/lib/import-pipeline";

export async function GET() {
  const jobs = await getImportJobsList();
  return NextResponse.json({ success: true, data: jobs });
}

export async function POST(request: Request) {
  try {
    const { skus } = await request.json();
    if (!Array.isArray(skus) || skus.length === 0) {
      return NextResponse.json({ success: false, error: "skus array required" }, { status: 400 });
    }
    if (skus.length > 50) {
      return NextResponse.json({ success: false, error: "Maximum 50 SKUs per batch" }, { status: 400 });
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

export const maxDuration = 60;
