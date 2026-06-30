import { NextResponse } from "next/server";
import { generateContent } from "@/lib/import-pipeline";
import { checkRateLimit } from "@/lib/rate-limiter";
import { isAuthenticated, isAdmin } from "@/lib/auth";

export async function POST(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  // Paid Anthropic generation is admin-only (P2-4): a reviewer session must not
  // burn API credits even if the proxy reviewer-allowlist ever widens.
  if (!(await isAdmin())) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }
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
