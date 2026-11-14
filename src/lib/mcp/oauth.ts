/**
 * OAuth 2.1 helpers for the remote MCP endpoint (authorization code + PKCE S256, dynamic client
 * registration). This is what claude.ai / the mobile app speak: the owner approves the connection
 * once on our consent page (signed-in admin session required) and no secret is ever typed or pasted.
 */
import crypto from "node:crypto";
import { hashMcpKey } from "@/lib/mcp/keys";

export const ACCESS_TTL_SEC = 3600;
export const REFRESH_TTL_SEC = 30 * 24 * 3600;
export const CODE_TTL_SEC = 600;

export const ACCESS_PREFIX = "amcpa_";
const REFRESH_PREFIX = "amcpr_";

export const newClientId = () => "cl_" + crypto.randomBytes(16).toString("base64url");
export const newAuthCode = () => "ac_" + crypto.randomBytes(32).toString("base64url");
export const newAccessToken = () => ACCESS_PREFIX + crypto.randomBytes(32).toString("base64url");
export const newRefreshToken = () => REFRESH_PREFIX + crypto.randomBytes(32).toString("base64url");
export const hashToken = hashMcpKey;

/** RFC 7636 S256: BASE64URL(SHA256(verifier)). */
export const pkceChallenge = (verifier: string) => crypto.createHash("sha256").update(verifier).digest("base64url");

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(pkceChallenge(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Where an authorization code may be sent. Only Anthropic's own callbacks (claude.ai / claude.com)
 * and loopback (Claude Code, local tools) — a registered client can't aim a code at an arbitrary site.
 */
export function isAllowedRedirectUri(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === "https:") {
    return u.hostname === "claude.ai" || u.hostname === "claude.com" || u.hostname.endsWith(".claude.ai") || u.hostname.endsWith(".claude.com");
  }
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, mcp-protocol-version",
};

/** Public origin of this deployment (the same host the client reached). */
export const originOf = (request: Request) => new URL(request.url).origin;

export function protectedResourceMetadata(origin: string) {
  return { resource: `${origin}/api/mcp`, authorization_servers: [origin], bearer_methods_supported: ["header"], scopes_supported: ["mcp"] };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  };
}
