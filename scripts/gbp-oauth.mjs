/**
 * Google Business Profile OAuth helper — mint a refresh token for the GBP posting pipeline.
 * Mirrors scripts/google-ads-oauth.mjs exactly (same installed-app loopback flow); only the
 * scope and env var names differ. See docs/GBP-SETUP.md for the full walkthrough, including
 * the Business Profile API access request you must have Google approve BEFORE this token is
 * of any use for actually publishing.
 *
 *   node-x64 scripts/gbp-oauth.mjs url
 *   node-x64 scripts/gbp-oauth.mjs exchange <code>
 *   node-x64 scripts/gbp-oauth.mjs whoami
 *
 * Reads GOOGLE_GBP_CLIENT_ID / _CLIENT_SECRET from .env.local, falling back to
 * GOOGLE_ADS_CLIENT_ID / _CLIENT_SECRET if unset — the same OAuth client works for both APIs
 * as long as the Business Profile API is enabled on that Cloud project.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SCOPE = "https://www.googleapis.com/auth/business.manage";
const TOKEN_OUT = "gbp-refresh-token.txt";

function discoverRedirect() {
  if (process.env.GOOGLE_GBP_REDIRECT_URI) return process.env.GOOGLE_GBP_REDIRECT_URI;
  let hit;
  try {
    hit = readdirSync(process.cwd()).find((n) => n.startsWith("client_secret_") && n.endsWith(".json"));
  } catch { /* unreadable cwd — fall through */ }
  if (hit) {
    try {
      const j = JSON.parse(readFileSync(join(process.cwd(), hit), "utf8"));
      const declared = (j.installed || j.web || {}).redirect_uris;
      if (declared && declared[0]) return declared[0];
    } catch { /* malformed download — fall through */ }
  }
  return "http://localhost";
}
const REDIRECT = discoverRedirect();

function envFile() {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const FILE_ENV = envFile();
const cfg = (k) => process.env[k] || FILE_ENV[k] || "";

function need(k, fallbackK) {
  const v = cfg(k) || (fallbackK ? cfg(fallbackK) : "");
  if (!v) {
    console.error(`${k}${fallbackK ? ` (or ${fallbackK})` : ""} is not set (env or .env.local). See docs/GBP-SETUP.md.`);
    process.exit(2);
  }
  return v;
}

const mask = (s) => (s.length <= 12 ? "***" : s.slice(0, 8) + "…" + s.slice(-4));

function buildUrl() {
  const p = new URLSearchParams({
    client_id: need("GOOGLE_GBP_CLIENT_ID", "GOOGLE_ADS_CLIENT_ID"),
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
}

async function exchange(code) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: need("GOOGLE_GBP_CLIENT_ID", "GOOGLE_ADS_CLIENT_ID"),
      client_secret: need("GOOGLE_GBP_CLIENT_SECRET", "GOOGLE_ADS_CLIENT_SECRET"),
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error(`Token exchange failed: HTTP ${res.status} — ${body.error_description || body.error || JSON.stringify(body)}`);
    if (body.error === "invalid_grant") {
      console.error("An authorisation code is single-use and expires in minutes. Re-run `url` and use the fresh code.");
    }
    process.exit(1);
  }
  if (!body.refresh_token) {
    console.error("Google returned no refresh_token. Re-run `url` (it sends prompt=consent) and authorise again.");
    process.exit(1);
  }
  if (process.argv.includes("--print")) {
    console.log(body.refresh_token);
    return;
  }
  writeFileSync(TOKEN_OUT, body.refresh_token + "\n", { mode: 0o600 });
  try { chmodSync(TOKEN_OUT, 0o600); } catch { /* Windows ACLs — best effort */ }
  console.log(`refresh_token written to ${TOKEN_OUT} (owner-only)`);
  console.log(`  ${mask(body.refresh_token)}`);
  console.log("\nCopy it into .env.local as GOOGLE_GBP_REFRESH_TOKEN, then delete the file.");
  console.log("It is NOT gitignored by name — do not commit it.");
}

async function whoami() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: need("GOOGLE_GBP_CLIENT_ID", "GOOGLE_ADS_CLIENT_ID"),
      client_secret: need("GOOGLE_GBP_CLIENT_SECRET", "GOOGLE_ADS_CLIENT_SECRET"),
      refresh_token: need("GOOGLE_GBP_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  const t = await r.json();
  if (!t.access_token) {
    console.error(`Refresh failed: ${t.error_description || t.error || JSON.stringify(t)}`);
    process.exit(1);
  }
  const res = await fetch("https://mybusiness.googleapis.com/v4/accounts", {
    headers: { Authorization: "Bearer " + t.access_token },
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`GET /v4/accounts: HTTP ${res.status} — ${body.slice(0, 300)}`);
    if (res.status === 403) {
      console.error("=> Most likely: the Business Profile API access request hasn't been approved yet for this");
      console.error("   Cloud project (Google gates write access — see docs/GBP-SETUP.md). This is NOT an OAuth bug.");
    }
    process.exit(1);
  }
  console.log("Accounts this refresh token can reach:");
  console.log(body);
}

const cmd = process.argv[2];
if (cmd === "url") {
  console.log(buildUrl());
  console.error(`\nredirect_uri: ${REDIRECT}`);
  console.error("Open it as the Google account that manages the Ameublo Direct Business Profile.");
  if (REDIRECT.startsWith("http://localhost") || REDIRECT.startsWith("http://127.0.0.1")) {
    console.error("After you approve, the browser will show a connection error -- that is EXPECTED,");
    console.error("nothing listens on localhost. Copy the code= value out of the address bar.");
  }
  console.error("Then: node-x64 scripts/gbp-oauth.mjs exchange <code>");
} else if (cmd === "exchange") {
  const code = process.argv[3];
  if (!code) { console.error("usage: gbp-oauth.mjs exchange <code>"); process.exit(2); }
  await exchange(code);
} else if (cmd === "whoami") {
  await whoami();
} else {
  console.error("usage: gbp-oauth.mjs <url | exchange <code> | whoami>");
  process.exit(2);
}
