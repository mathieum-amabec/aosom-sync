import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { listAssistantBlocks, listAssistantTopVisitors, unblockAssistantIp } from "@/lib/database";
import { DAILY_TOKENS_PER_IP, ABUSE_BLOCK_SCORE } from "@/lib/assistant-guard";

/**
 * GET  /api/assistant-guard — the storefront assistant's automatic blocks + today's heaviest
 *                             visitors (hashed addresses only, never raw IPs).
 * POST /api/assistant-guard — {action:"unblock", ipHash}: lift a block now.
 */
export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const [blocks, visitors] = await Promise.all([listAssistantBlocks(), listAssistantTopVisitors()]);
    return NextResponse.json({
      success: true,
      data: { blocks, visitors, limits: { dailyTokensPerVisitor: DAILY_TOKENS_PER_IP, abuseBlockScore: ABUSE_BLOCK_SCORE } },
    });
  } catch (err) {
    console.error("[API] /api/assistant-guard GET failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ((await getSessionRole()) === "reviewer") {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }
  try {
    const body = (await request.json()) as { action?: string; ipHash?: string };
    if (body.action !== "unblock" || typeof body.ipHash !== "string" || !/^[0-9a-f]{24}$/.test(body.ipHash)) {
      return NextResponse.json({ success: false, error: "Requête invalide" }, { status: 400 });
    }
    await unblockAssistantIp(body.ipHash);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[API] /api/assistant-guard POST failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
