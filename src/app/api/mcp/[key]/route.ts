import { handleMcpHttp, methodNotAllowed } from "@/lib/mcp/http";

/**
 * POST /api/mcp/<key> — same endpoint, key in the URL. claude.ai "custom connectors" (and so the
 * mobile app) only take a URL, not a custom header. The key is a revocable secret (Réglages → MCP):
 * treat the whole URL as a password — it appears in request logs, so revoke it if it leaks.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ key: string }> }) {
  return handleMcpHttp(request, (await ctx.params).key);
}
export const GET = methodNotAllowed;
