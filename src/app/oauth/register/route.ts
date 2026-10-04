import { NextResponse } from "next/server";
import { registerOAuthClient } from "@/lib/database";
import { CORS, isAllowedRedirectUri, newClientId } from "@/lib/mcp/oauth";

/** RFC 7591 dynamic client registration. Public clients only; redirect URIs restricted to Anthropic + loopback. */
export const dynamic = "force-dynamic";

const err = (error: string, description: string) =>
  NextResponse.json({ error, error_description: description }, { status: 400, headers: CORS });

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown } | null;
  const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (uris.length === 0 || uris.length > 10) return err("invalid_redirect_uri", "redirect_uris is required");
  if (!uris.every(isAllowedRedirectUri)) return err("invalid_redirect_uri", "redirect URI not allowed");
  const name = (typeof body?.client_name === "string" ? body.client_name.trim() : "").slice(0, 80) || "MCP client";
  const clientId = newClientId();
  await registerOAuthClient(clientId, name, uris);
  return NextResponse.json({
    client_id: clientId, client_name: name, redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
  }, { status: 201, headers: CORS });
}
export const OPTIONS = () => new NextResponse(null, { status: 204, headers: CORS });
