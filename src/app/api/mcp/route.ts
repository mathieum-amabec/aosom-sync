import { NextResponse } from "next/server";
import { ensureSchema, verifyMcpKey } from "@/lib/database";
import { bearerKey, hashMcpKey } from "@/lib/mcp/keys";
import { handleMessage } from "@/lib/mcp/protocol";

/**
 * POST /api/mcp — remote MCP endpoint (JSON-RPC over HTTP, one message per request).
 *
 * Public to the session proxy (see PUBLIC_PATHS) because it authenticates itself with an MCP key
 * (`Authorization: Bearer amcp_…`, managed in Réglages → MCP). Read-only tools only — the same set
 * as the local stdio server (src/lib/mcp/tools.ts). Claude Desktop reaches it through
 * scripts/mcp-remote.mjs.
 */
export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 100_000;

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

export async function POST(request: Request) {
  const key = bearerKey(request.headers.get("authorization"));
  if (!key) return unauthorized();
  try {
    if (!(await verifyMcpKey(hashMcpKey(key)))) return unauthorized();
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    let msg: unknown;
    try { msg = JSON.parse(text); } catch {
      return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, { status: 400 });
    }
    const res = await handleMessage(await ensureSchema(), msg as never);
    return res ? NextResponse.json(res) : new NextResponse(null, { status: 202 });
  } catch (err) {
    console.error("[API] /api/mcp failed:", err);
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed — POST JSON-RPC messages here" }, { status: 405, headers: { Allow: "POST" } });
}
