// TikTok OAuth helper — authorize the app on ONE brand account (fr = Ameublo Direct, en = Furnish Direct) and store the
// tokens (refreshed automatically by src/lib/tiktok-auth.ts). See docs/TIKTOK-SETUP.md.
//
//   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/tiktok-oauth.mts url      --brand fr|en
//   …                                                                scripts/tiktok-oauth.mts exchange "<address>" --brand fr|en
//   …                                                                scripts/tiktok-oauth.mts whoami    --brand fr|en
//   …                                                                scripts/tiktok-oauth.mts refresh   --brand fr|en
//
// Reads TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_REDIRECT_URI (absolute https, registered on the app; the page it
// points to does not matter — you copy the address bar). Tokens are masked in the output. With .env.local the tokens are
// written to the PRODUCTION settings table (key tiktok_oauth_<brand>).
//
// IMPORTS: runtime values via DYNAMIC import (tsx transpiles src/**/*.ts to CJS) — same convention as the other .mts scripts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("--"));
const brandIdx = args.indexOf("--brand");
const brandArg = brandIdx >= 0 ? args[brandIdx + 1] : undefined;

const auth = await import("@/lib/tiktok-auth");
const { TikTokClient } = await import("@/lib/tiktok-client");

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY ?? "";
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET ?? "";
const REDIRECT = process.env.TIKTOK_REDIRECT_URI ?? "";
const mask = (s: string) => (s.length <= 12 ? "***" : `${s.slice(0, 6)}…${s.slice(-4)}`);
const when = (sec: number | null) => (sec ? new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "?");

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}
if (brandArg !== "fr" && brandArg !== "en") fail("Précise le compte : --brand fr (Ameublo Direct) ou --brand en (Furnish Direct).");
const brand = brandArg;
const needApp = () => {
  if (!CLIENT_KEY || !CLIENT_SECRET) fail("TIKTOK_CLIENT_KEY et TIKTOK_CLIENT_SECRET doivent être dans .env.local (jamais dans le chat).");
};
const needRedirect = () => {
  if (!/^https:\/\//i.test(REDIRECT)) fail("TIKTOK_REDIRECT_URI doit être une adresse https enregistrée sur l'app TikTok (pas de localhost). Voir docs/TIKTOK-SETUP.md.");
};
const store = auth.settingsTokenStore(brand);
const STATE_FILE = path.join(os.tmpdir(), `tiktok-oauth-state-${brand}.txt`);

switch (cmd) {
  case "url": {
    if (!CLIENT_KEY) fail("TIKTOK_CLIENT_KEY manquant dans .env.local.");
    needRedirect();
    const state = crypto.randomBytes(12).toString("hex");
    fs.writeFileSync(STATE_FILE, state);
    console.log(`\n1. Dans un navigateur où tu es connecté au compte TikTok « ${brand === "fr" ? "Ameublo Direct" : "Furnish Direct"} » (pas ton compte personnel), ouvre :\n\n${auth.buildAuthorizeUrl({ clientKey: CLIENT_KEY, redirectUri: REDIRECT, state })}\n`);
    console.log(`2. Autorise. TikTok te redirige vers ${REDIRECT}?code=…  (la page peut être vide ou en erreur : c'est normal).`);
    console.log(`3. Copie l'adresse complète de la barre du navigateur et lance :\n   … tiktok-oauth.mts exchange "<adresse>" --brand ${brand}\n`);
    break;
  }
  case "exchange": {
    needApp();
    needRedirect();
    const input = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--brand")[1];
    if (!input) fail("Usage : exchange <code | adresse de redirection> --brand fr|en");
    const { code, state } = auth.parseAuthorizationCode(input);
    if (!code) fail("Aucun « code » trouvé dans ce que tu as collé.");
    const expected = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, "utf8").trim() : null;
    if (state && expected && state !== expected) fail("Le « state » ne correspond pas à celui du lien généré : abandon (lien d'un autre essai ?).");
    const tokens = await auth.exchangeAuthorizationCode(code, REDIRECT, brand, { clientKey: CLIENT_KEY, clientSecret: CLIENT_SECRET });
    await store.save(tokens);
    fs.rmSync(STATE_FILE, { force: true });
    console.log(`\n✓ Compte « ${brand} » autorisé. Jeton ${mask(tokens.access_token)} valable jusqu'au ${when(tokens.expires_at)} (renouvelé automatiquement), renouvellement jusqu'au ${when(tokens.refresh_expires_at)}.`);
    console.log(`  Permissions : ${tokens.scope || "(non précisées)"}\n  Enregistré dans les réglages (${auth.tiktokTokenSetting(brand)}). Étape suivante : whoami.\n`);
    break;
  }
  case "refresh": {
    needApp();
    const cur = await store.load();
    if (!cur) fail(`Aucun jeton pour « ${brand} » : lance d'abord « url » puis « exchange ».`);
    const fresh = await auth.refreshTokens(cur, { clientKey: CLIENT_KEY, clientSecret: CLIENT_SECRET });
    await store.save(fresh);
    console.log(`\n✓ Jeton renouvelé : ${mask(fresh.access_token)} jusqu'au ${when(fresh.expires_at)}.\n`);
    break;
  }
  case "whoami": {
    const tokens = await auth.getStoredTokens({ store, clientKey: CLIENT_KEY, clientSecret: CLIENT_SECRET });
    if (!tokens) fail(`Aucun jeton pour « ${brand} » : « url » puis « exchange » d'abord.`);
    const me = await new TikTokClient({ accessToken: tokens.access_token }).userInfo();
    console.log(`\n✓ Compte TikTok autorisé pour « ${brand} » : ${me.displayName || "?"}${me.username ? ` (@${me.username})` : ""}  open_id ${me.openId || tokens.open_id}`);
    console.log(`  Permissions : ${tokens.scope}\n`);
    break;
  }
  default:
    fail("Usage : tiktok-oauth.mts url | exchange <adresse> | whoami | refresh  --brand fr|en");
}
