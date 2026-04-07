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
    const jobs = await queueForImport(skus);
    return NextResponse.json({ success: true, data: jobs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export const maxDuration = 60;
