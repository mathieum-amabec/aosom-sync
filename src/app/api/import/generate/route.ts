import { NextResponse } from "next/server";
import { generateContent } from "@/lib/import-pipeline";

export async function POST(request: Request) {
  try {
    const { jobId } = await request.json();
    if (!jobId || typeof jobId !== "string" || jobId.length > 100) {
      return NextResponse.json({ success: false, error: "Valid jobId required" }, { status: 400 });
    }
    const job = await generateContent(jobId);
    return NextResponse.json({ success: true, data: job });
  } catch (err) {
    console.error(`[API] /api/import/generate failed:`, err);
    return NextResponse.json({ success: false, error: "Content generation failed" }, { status: 500 });
  }
}

export const maxDuration = 120;
