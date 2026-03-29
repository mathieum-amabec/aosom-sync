import { NextResponse } from "next/server";
import { importToShopify } from "@/lib/import-pipeline";

export async function POST(request: Request) {
  try {
    const { jobId, content } = await request.json();
    if (!jobId) {
      return NextResponse.json(
        { error: "jobId required" },
        { status: 400 }
      );
    }

    const job = await importToShopify(jobId, content);
    return NextResponse.json({ ok: true, job });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export const maxDuration = 60;
