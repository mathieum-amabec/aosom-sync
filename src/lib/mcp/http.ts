import { NextResponse } from "next/server";
import { ensureSchema, verifyMcpKey } from "@/lib/database";
import { hashMcpKey, MCP_KEY_RE } from "@/lib/mcp/keys";
import { handleMessage } from "@/lib/mcp/protocol";

const MAX_BODY_BYTES = 100_000;

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

/** Shared by POST /api/mcp (Bearer header) and POST /api/mcp/<key> (key in the URL, for claude.ai connectors). */
export async function handleMcpHttp(request: Request, key: string | null): Promise<Response> {
  if (!key || !MCP_KEY_RE.test(key)) return unauthorized();
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
    console.error("[API] /api/mcp failed:", err instanceof Error ? err.message : "error");
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }, { status: 500 });
  }
}

export const methodNotAllowed = () =>
  NextResponse.json({ error: "Method not allowed — POST JSON-RPC messages here" }, { status: 405, headers: { Allow: "POST" } });
