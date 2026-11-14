import { NextResponse } from "next/server";
import { createOAuthGrantWithCode, findActiveMcpKey, getOAuthClient, type OAuthClientRow } from "@/lib/database";
import { MCP_KEY_RE, hashMcpKey } from "@/lib/mcp/keys";
import { CODE_TTL_SEC, escapeHtml, hashToken, newAuthCode, originOf } from "@/lib/mcp/oauth";

/**
 * OAuth authorization endpoint = the page claude.ai opens after you add the connector.
 * You approve by pasting the access key created in Réglages → MCP; that key decides the permissions
 * (Lecture / Analytics / Import). The authorization code only ever goes to a redirect URI registered
 * for the client (Anthropic / loopback), and a wrong key never reaches the redirect.
 */
export const dynamic = "force-dynamic";

interface AuthParams { clientId: string; redirectUri: string; state: string; challenge: string }
const FIELDS = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state"];

function page(status: number, body: string): NextResponse {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autoriser l'accès</title><style>
body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e5e7eb;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#12151c;border:1px solid #232733;border-radius:14px;padding:28px;max-width:420px;width:100%;margin:16px}
h1{font-size:20px;margin:0 0 12px}p{color:#9ca3af;font-size:14px;line-height:1.5}b{color:#e5e7eb}
input[type=password],input[type=text]{width:100%;box-sizing:border-box;padding:12px;border-radius:9px;border:1px solid #2d3340;background:#0b0d12;color:#e5e7eb;font-size:15px;margin-top:8px}
.err{color:#f87171;font-size:14px;margin:10px 0 0}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:12px;border-radius:9px;border:0;font-size:15px;cursor:pointer}
.ok{background:#2563eb;color:#fff}.no{background:#232733;color:#e5e7eb}
</style></head><body><div class="card">${body}</div></body></html>`;
  return new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
const errorPage = (status: number, msg: string) => page(status, `<h1>Demande refusée</h1><p>${escapeHtml(msg)}</p>`);

/** Validate the request against the registered client. Never redirects on a bad client / redirect_uri. */
async function validate(get: (k: string) => string | null): Promise<{ ok: true; p: AuthParams; client: OAuthClientRow } | { ok: false; msg: string }> {
  const clientId = get("client_id") || "";
  const client = clientId ? await getOAuthClient(clientId) : null;
  if (!client) return { ok: false, msg: "Application inconnue." };
  const redirectUri = get("redirect_uri") || "";
  if (!client.redirect_uris.includes(redirectUri)) return { ok: false, msg: "Adresse de retour non enregistrée." };
  if (get("response_type") !== "code") return { ok: false, msg: "Type de réponse non supporté." };
  const challenge = get("code_challenge") || "";
  if (get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return { ok: false, msg: "PKCE (S256) requis." };
  return { ok: true, p: { clientId, redirectUri, state: get("state") || "", challenge }, client };
}

function back(redirectUri: string, params: Record<string, string>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return NextResponse.redirect(u.toString(), 302);
}

function consent(client: OAuthClientRow, redirectUri: string, get: (k: string) => string | null, error?: string): NextResponse {
  const hidden = FIELDS.map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(get(k) || "")}">`).join("");
  return page(error ? 401 : 200, `<h1>Autoriser « ${escapeHtml(client.client_name)} »</h1>
<p>Colle ici la <b>clé d'accès</b> créée dans Aosom-sync (Réglages → MCP). Ses permissions (Lecture, Analytics, Import) seront celles de cette connexion.</p>
<form method="post" action="/oauth/authorize">${hidden}
<input type="password" name="access_key" placeholder="amcp_…" autocomplete="off" autocapitalize="off" spellcheck="false" required>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<div class="row"><button class="no" name="decision" value="deny" formnovalidate>Refuser</button><button class="ok" name="decision" value="approve">Autoriser</button></div></form>
<p style="font-size:12px;margin-top:16px">Retour vers <b>${escapeHtml(new URL(redirectUri).host)}</b>. Tu peux révoquer l'accès à tout moment dans Réglages → MCP.</p>`);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const get = (k: string) => url.searchParams.get(k);
  const v = await validate(get);
  if (!v.ok) return errorPage(400, v.msg);
  return consent(v.client, v.p.redirectUri, get);
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== originOf(request)) return errorPage(403, "Origine non autorisée.");
  const form = await request.formData().catch(() => null);
  if (!form) return errorPage(400, "Formulaire invalide.");
  const get = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : null);
  const v = await validate(get);
  if (!v.ok) return errorPage(400, v.msg);

  if (get("decision") !== "approve") return back(v.p.redirectUri, { error: "access_denied", state: v.p.state });

  const key = (get("access_key") || "").trim();
  const found = MCP_KEY_RE.test(key) ? await findActiveMcpKey(hashMcpKey(key)) : null;
  if (!found) return consent(v.client, v.p.redirectUri, get, "Clé invalide ou révoquée. Vérifie que tu as collé la clé complète.");

  const code = newAuthCode();
  await createOAuthGrantWithCode({
    clientId: v.p.clientId, clientName: v.client.client_name, redirectUri: v.p.redirectUri,
    codeChallenge: v.p.challenge, codeHash: hashToken(code), ttlSec: CODE_TTL_SEC, scope: found.scope, keyId: found.id,
  });
  return back(v.p.redirectUri, { code, state: v.p.state });
}
