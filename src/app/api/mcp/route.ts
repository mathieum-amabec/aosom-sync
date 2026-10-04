import { bearerKey } from "@/lib/mcp/keys";
import { handleMcpHttp, methodNotAllowed } from "@/lib/mcp/http";

/**
 * POST /api/mcp — remote MCP endpoint (JSON-RPC over HTTP, one message per request).
 *
 * Public to the session proxy (see PUBLIC_PATHS) because it authenticates itself with an MCP key
 * (`Authorization: Bearer amcp_…`, managed in Réglages → MCP). Read-only tools only — the same set
 * as the local stdio server (src/lib/mcp/tools.ts). Claude Desktop reaches it through
 * scripts/mcp-remote.mjs; claude.ai / the mobile app authorize through OAuth (src/app/oauth/*) and send an access token here.
 */
export const dynamic = "force-dynamic";
// import_confirm generates copy and pushes to Shopify (the tool keeps its own 230 s time budget).
export const maxDuration = 300;

export const POST = (request: Request) => handleMcpHttp(request, bearerKey(request.headers.get("authorization")));
export const GET = methodNotAllowed;
