import { NextResponse } from "next/server";
import { ensureSchema, verifyMcpKey, verifyOAuthAccess } from "@/lib/database";
import { hashMcpKey, MCP_KEY_RE } from "@/lib/mcp/keys";
import { ACCESS_PREFIX, originOf } from "@/lib/mcp/oauth";
import { handleMessage } from "@/lib/mcp/protocol";

const MAX_BODY_BYTES = 100_000;

// The resource_metadata hint is what makes claude.ai start the OAuth flow (RFC 9728).
const unauthorized = (request: Request) =>
  NextResponse.json({ error: "Unauthorized" }, {
    status: 401,
    headers: { "WWW-Authenticate": `Bearer resource_metadata="${originOf(request)}/.well-known/oauth-protected-resource/api/mcp"` },
  });

const ACCESS_TOKEN_RE = new RegExp(`^${ACCESS_PREFIX}[A-Za-z0-9_-]{20,}$`);

/** Bearer credential → is it a live dashboard key (amcp_) or OAuth access token (amcpa_)? */
async function authenticate(token: string | null): Promise<boolean> {
  if (!token) return false;
  if (ACCESS_TOKEN_RE.test(token)) return verifyOAuthAccess(hashMcpKey(token));
  if (MCP_KEY_RE.test(token)) return verifyMcpKey(hashMcpKey(token));
  return false;
}

/** POST /api/mcp: Bearer header = OAuth access token (claude.ai / mobile) or dashboard key (Desktop bridge). */
export async function handleMcpHttp(request: Request, token: string | null): Promise<Response> {
  try {
    if (!(await authenticate(token))) return unauthorized(request);
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
