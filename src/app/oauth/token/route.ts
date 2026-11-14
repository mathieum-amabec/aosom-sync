import { NextResponse } from "next/server";
import { consumeOAuthCode, consumeOAuthRefresh, getOAuthClient, storeOAuthTokens } from "@/lib/database";
import {
  ACCESS_TTL_SEC, CORS, REFRESH_TTL_SEC, hashToken, newAccessToken, newRefreshToken, pkceMatches,
} from "@/lib/mcp/oauth";

/** OAuth token endpoint: authorization_code (+PKCE) and rotating refresh_token. Public clients (no secret). */
export const dynamic = "force-dynamic";

const fail = (error: string, description: string, status = 400) =>
  NextResponse.json({ error, error_description: description }, { status, headers: { ...CORS, "Cache-Control": "no-store" } });

async function readParams(request: Request): Promise<URLSearchParams> {
  const text = await request.text();
  if ((request.headers.get("content-type") || "").includes("json")) {
    try {
      return new URLSearchParams(Object.entries(JSON.parse(text) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    } catch { return new URLSearchParams(); }
  }
  return new URLSearchParams(text);
}

async function issue(grantId: number) {
  const access = newAccessToken();
  const refresh = newRefreshToken();
  await storeOAuthTokens(grantId, { hash: hashToken(access), ttlSec: ACCESS_TTL_SEC }, { hash: hashToken(refresh), ttlSec: REFRESH_TTL_SEC });
  return NextResponse.json(
    { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_SEC, refresh_token: refresh, scope: "mcp" },
    { headers: { ...CORS, "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const p = await readParams(request);
  const clientId = p.get("client_id") || "";
  const client = clientId ? await getOAuthClient(clientId) : null;
  if (!client) return fail("invalid_client", "unknown client_id", 401);

  const grant = p.get("grant_type");
  if (grant === "authorization_code") {
    const code = p.get("code") || "";
    const row = code ? await consumeOAuthCode(hashToken(code)) : null;
    if (!row || row.client_id !== clientId) return fail("invalid_grant", "invalid or expired code");
    if (row.redirect_uri !== (p.get("redirect_uri") || "")) return fail("invalid_grant", "redirect_uri mismatch");
    if (!pkceMatches(p.get("code_verifier") || "", row.code_challenge)) return fail("invalid_grant", "PKCE verification failed");
    return issue(row.grant_id);
  }
  if (grant === "refresh_token") {
    const refresh = p.get("refresh_token") || "";
    const row = refresh ? await consumeOAuthRefresh(hashToken(refresh)) : null;
    if (!row || row.client_id !== clientId) return fail("invalid_grant", "invalid or expired refresh token");
    return issue(row.grant_id);
  }
  return fail("unsupported_grant_type", "use authorization_code or refresh_token");
}
export const OPTIONS = () => new NextResponse(null, { status: 204, headers: CORS });
