import { NextResponse } from "next/server";
import { generateContent } from "@/lib/import-pipeline";

export async function POST(request: Request) {
  try {
    const { jobId } = await request.json();
    if (!jobId) {
      return NextResponse.json({ success: false, error: "jobId required" }, { status: 400 });
    }
    const job = await generateContent(jobId);
    return NextResponse.json({ success: true, data: job });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export const maxDuration = 120;
