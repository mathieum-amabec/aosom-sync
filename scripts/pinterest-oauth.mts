// Pinterest OAuth helper — authorize the "ameublo publisher" app on the Pinterest Business account and store
// the tokens (they are then refreshed automatically by src/lib/pinterest-auth.ts). See docs/PINTEREST-SETUP.md.
//
//   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/pinterest-oauth.mts url      [--sandbox]
//   …                                                                scripts/pinterest-oauth.mts exchange <code | redirect URL> [--sandbox]
//   …                                                                scripts/pinterest-oauth.mts whoami   [--sandbox]
//   …                                                                scripts/pinterest-oauth.mts refresh  [--sandbox]
//
// Reads PINTEREST_APP_ID and PINTEREST_APP_SECRET (+ PINTEREST_REDIRECT_URI, default http://localhost:8085/ — it must
// be listed among the app's redirect URIs on developers.pinterest.com). Nothing is printed in full: tokens are masked.
//
// ⚠ With .env.local the tokens are written to the PRODUCTION settings table (Turso). Use --sandbox while the app is
// on Trial access: sandbox tokens go under their own key and never touch real Pins.
//
// IMPORTS: runtime values via DYNAMIC import (tsx transpiles src/**/*.ts to CJS) — same convention as the other .mts scripts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("--"));
const sandbox = args.includes("--sandbox");

const auth = await import("@/lib/pinterest-auth");
const { pinterestApiBase } = await import("@/lib/pinterest-client");

const APP_ID = process.env.PINTEREST_APP_ID ?? "";
const APP_SECRET = process.env.PINTEREST_APP_SECRET ?? "";
const REDIRECT = process.env.PINTEREST_REDIRECT_URI || "http://localhost:8085/";
const STATE_FILE = path.join(os.tmpdir(), `pinterest-oauth-state${sandbox ? "-sandbox" : ""}.txt`);
const mask = (s: string) => (s.length <= 12 ? "***" : `${s.slice(0, 8)}…${s.slice(-4)}`);
const when = (sec: number | null) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : "?");

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}
const needApp = () => {
  if (!APP_ID || !APP_SECRET) fail("PINTEREST_APP_ID et PINTEREST_APP_SECRET doivent être dans .env.local (jamais dans le chat).");
};
const store = auth.settingsTokenStore(sandbox ? "sandbox" : "production");

switch (cmd) {
  case "url": {
    if (!APP_ID) fail("PINTEREST_APP_ID manquant dans .env.local.");
    const state = crypto.randomBytes(12).toString("hex");
    fs.writeFileSync(STATE_FILE, state);
    console.log(`\n1. Ouvre ce lien, connecte-toi avec le compte Pinterest Business et clique « Donner l'accès » :\n\n${auth.buildAuthorizeUrl({ appId: APP_ID, redirectUri: REDIRECT, state })}\n`);
    console.log(`2. Pinterest te redirige vers ${REDIRECT}?code=…  (la page peut afficher une erreur : c'est normal).`);
    console.log(`3. Copie l'adresse complète de la barre du navigateur et lance :\n   … pinterest-oauth.mts exchange "<adresse>"${sandbox ? " --sandbox" : ""}\n`);
    break;
  }
  case "exchange": {
    needApp();
    const input = args.filter((a) => !a.startsWith("--"))[1];
    if (!input) fail("Usage : exchange <code | adresse de redirection>");
    const { code, state } = auth.parseAuthorizationCode(input);
    if (!code) fail("Aucun « code » trouvé dans ce que tu as collé.");
    const expected = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, "utf8").trim() : null;
    if (state && expected && state !== expected) fail("Le « state » ne correspond pas à celui du lien généré : abandon (possible lien d'un autre essai).");
    const tokens = await auth.exchangeAuthorizationCode(code, REDIRECT, { appId: APP_ID, appSecret: APP_SECRET, sandbox });
    await store.save(tokens);
    fs.rmSync(STATE_FILE, { force: true });
    console.log(`\n✓ Autorisé (${tokens.env}). Jeton ${mask(tokens.access_token)} valable jusqu'au ${when(tokens.expires_at)}, renouvellement jusqu'au ${when(tokens.refresh_expires_at)}.`);
    console.log(`  Permissions : ${tokens.scope || "(non précisées)"}\n  Enregistré dans les réglages (${sandbox ? "pinterest_oauth_sandbox" : "pinterest_oauth"}). Étape suivante : whoami.\n`);
    break;
  }
  case "refresh": {
    needApp();
    const cur = await store.load();
    if (!cur) fail("Aucun jeton enregistré : lance d'abord « url » puis « exchange ».");
    const fresh = await auth.refreshTokens(cur, { appId: APP_ID, appSecret: APP_SECRET });
    await store.save(fresh);
    console.log(`\n✓ Jeton renouvelé : ${mask(fresh.access_token)} jusqu'au ${when(fresh.expires_at)}.\n`);
    break;
  }
  case "whoami": {
    const tokens = await auth.getStoredTokens({ store, appId: APP_ID, appSecret: APP_SECRET });
    const token = tokens?.access_token ?? process.env.PINTEREST_ACCESS_TOKEN;
    if (!token) fail("Aucun jeton : « url » puis « exchange », ou PINTEREST_ACCESS_TOKEN dans .env.local.");
    const base = pinterestApiBase(sandbox || tokens?.env === "sandbox");
    const get = async (p: string) => {
      const r = await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${token}` } });
      return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
    };
    const me = await get("/user_account");
    if (me.status !== 200) fail(`/user_account → HTTP ${me.status} ${JSON.stringify(me.json)}\n  (« consumer type is not supported » = l'application n'est pas encore approuvée par Pinterest.)`);
    console.log(`\n✓ Compte : ${me.json.username ?? "?"} (${me.json.account_type ?? "?"}) — environnement ${base.includes("sandbox") ? "SANDBOX" : "production"}`);
    const boards = await get("/boards?page_size=50");
    const items = (boards.json.items as { id: string; name: string; privacy?: string }[] | undefined) ?? [];
    console.log(items.length ? "\nTableaux (mets l'identifiant choisi dans PINTEREST_BOARD_ID) :" : "\nAucun tableau : crée-en un sur pinterest.com puis relance.");
    for (const b of items) console.log(`  ${b.id}  ${b.name}  [${b.privacy ?? "?"}]`);
    console.log();
    break;
  }
  default:
    fail("Usage : pinterest-oauth.mts url | exchange <code> | whoami | refresh  [--sandbox]");
}
