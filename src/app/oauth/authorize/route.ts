import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createOAuthGrantWithCode, getOAuthClient, type OAuthClientRow } from "@/lib/database";
import { CODE_TTL_SEC, escapeHtml, hashToken, newAuthCode, originOf } from "@/lib/mcp/oauth";

/**
 * OAuth authorization endpoint = the consent page. The connection is only granted after the owner,
 * signed in to this dashboard as admin, clicks "Autoriser" — nothing is typed or pasted, and the
 * authorization code goes only to a redirect URI registered for the client (Anthropic / loopback).
 */
export const dynamic = "force-dynamic";

interface AuthParams { clientId: string; redirectUri: string; state: string; challenge: string }

function page(status: number, body: string): NextResponse {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autoriser l'accès</title><style>
body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e5e7eb;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#12151c;border:1px solid #232733;border-radius:14px;padding:28px;max-width:420px;margin:16px}
h1{font-size:20px;margin:0 0 12px}p{color:#9ca3af;font-size:14px;line-height:1.5}b{color:#e5e7eb}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:11px;border-radius:9px;border:0;font-size:15px;cursor:pointer}
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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const v = await validate((k) => url.searchParams.get(k));
  if (!v.ok) return errorPage(400, v.msg);
  const session = await getSession();
  if (!session) {
    const login = new URL("/login", url.origin);
    login.searchParams.set("redirect", url.pathname + url.search);
    return NextResponse.redirect(login.toString(), 302);
  }
  if (session.role !== "admin") return errorPage(403, "Seul un administrateur peut autoriser une connexion.");

  const host = new URL(v.p.redirectUri).host;
  const hidden = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state"]
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(url.searchParams.get(k) || "")}">`).join("");
  return page(200, `<h1>Autoriser « ${escapeHtml(v.client.client_name)} » ?</h1>
<p>Cette application demande un accès <b>en lecture seule</b> au catalogue (recherche de produits Aosom et Costway, file d'import, budget LLM, état des tâches). Elle ne pourra rien modifier.</p>
<p>Connecté en tant que <b>${escapeHtml(session.username)}</b> · retour vers <b>${escapeHtml(host)}</b></p>
<form method="post" action="/oauth/authorize">${hidden}
<div class="row"><button class="no" name="decision" value="deny">Refuser</button><button class="ok" name="decision" value="approve">Autoriser</button></div></form>
<p style="font-size:12px;margin-top:16px">Tu pourras révoquer cet accès à tout moment dans Réglages → MCP.</p>`);
}

export async function POST(request: Request) {
  // Same-origin form post only (the session cookie is SameSite=lax; this is belt and braces).
  const origin = request.headers.get("origin");
  if (origin && origin !== originOf(request)) return errorPage(403, "Origine non autorisée.");
  const form = await request.formData().catch(() => null);
  if (!form) return errorPage(400, "Formulaire invalide.");
  const get = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : null);
  const v = await validate(get);
  if (!v.ok) return errorPage(400, v.msg);
  const session = await getSession();
  if (!session || session.role !== "admin") return errorPage(403, "Session administrateur requise.");

  if (get("decision") !== "approve") return back(v.p.redirectUri, { error: "access_denied", state: v.p.state });
  const code = newAuthCode();
  await createOAuthGrantWithCode({
    clientId: v.p.clientId, clientName: v.client.client_name, redirectUri: v.p.redirectUri,
    codeChallenge: v.p.challenge, codeHash: hashToken(code), ttlSec: CODE_TTL_SEC,
  });
  return back(v.p.redirectUri, { code, state: v.p.state });
}
