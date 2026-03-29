import { NextResponse } from "next/server";
import { queueForImport, getImportJobsList } from "@/lib/import-pipeline";

export async function GET() {
  const jobs = await getImportJobsList();
  return NextResponse.json({ jobs });
}

export async function POST(request: Request) {
  try {
    const { skus } = await request.json();
    if (!Array.isArray(skus) || skus.length === 0) {
      return NextResponse.json({ error: "skus array required" }, { status: 400 });
    }
    const jobs = await queueForImport(skus);
    return NextResponse.json({ ok: true, jobs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export const maxDuration = 60;
