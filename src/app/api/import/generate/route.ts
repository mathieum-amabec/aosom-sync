import { NextResponse } from "next/server";
import { generateContent } from "@/lib/import-pipeline";
import { checkRateLimit } from "@/lib/rate-limiter";

export async function POST(request: Request) {
  try {
    // Rate limit: 30 Claude API calls per minute
    const { allowed, retryAfterMs } = checkRateLimit("claude-generate", 30, 60_000);
    if (!allowed) {
      return NextResponse.json(
        { success: false, error: "Rate limit exceeded. Try again shortly.", retryAfter: Math.ceil(retryAfterMs / 1000) },
        { status: 429 }
      );
    }

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
