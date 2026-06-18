// Verify the configured META_ACCESS_TOKEN via Graph `debug_token`.
//
// READ-ONLY / DRY-RUN ONLY: it issues a single GET /debug_token and prints what
// the token is. It never creates, edits, or rotates anything.
//
// Reports:
//   - type       USER vs SYSTEM_USER (system-user tokens are the long-lived,
//                production-recommended kind — see docs/META-ADS-SETUP.md §2B)
//   - expires_at when the token expires (and data_access_expires_at)
//   - scopes     granted permissions (ads_read / ads_management / …)
//
// Usage (run under x64 node — see CLAUDE.md / [[bun-x64-crashes-on-network-scripts]];
// bun-x64 dies on HTTPS under arm64 emulation, so use node-x64):
//   node scripts/verify-meta-token.mjs
//
// A token may debug itself, so no app-token / app-secret is needed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const raw = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

// Match the Graph version used by the Meta Ads client (config.ts META.API_VERSION = v18.0).
const GRAPH = "https://graph.facebook.com/v18.0";

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

const TOKEN = loadEnv().META_ACCESS_TOKEN;
if (!TOKEN) fail("META_ACCESS_TOKEN not set in .env.local — see docs/META-ADS-SETUP.md §3");

async function graph(path, { params = {} } = {}) {
  const url = new URL(`${GRAPH}/${path.replace(/^\//, "")}`);
  url.searchParams.set("access_token", TOKEN);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url.toString()); // GET only — never mutates
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    throw new Error(`Meta API: ${data.error.error_user_msg || data.error.message}${data.error.code ? ` (code ${data.error.code})` : ""}`);
  }
  if (!res.ok) throw new Error(`Meta API HTTP ${res.status} on ${path}`);
  return data;
}

function fmtTs(ts) {
  const n = Number(ts);
  if (!n) return "never (long-lived / system-user)";
  const d = new Date(n * 1000);
  const days = Math.round((n * 1000 - Date.now()) / 86_400_000);
  const rel = days < 0 ? `${Math.abs(days)}d ago — EXPIRED` : `in ${days}d`;
  return `${d.toISOString()} (${rel})`;
}

console.log("=== verify-meta-token (READ-ONLY) ===");
console.log(`Graph:  ${GRAPH}`);
console.log(`Token:  …${TOKEN.slice(-6)} (${TOKEN.length} chars)\n`);

const res = await graph("debug_token", { params: { input_token: TOKEN } });
const d = res.data ?? {};

const type = d.type ?? "unknown";
const scopes = d.scopes ?? [];
const required = ["ads_read", "ads_management"];
const missing = required.filter((s) => !scopes.includes(s));

console.log(`valid:                  ${d.is_valid ? "yes" : "NO"}`);
console.log(`type:                   ${type}${type === "SYSTEM_USER" ? "  ✓ long-lived (recommended)" : type === "USER" ? "  ⚠ user token — short-lived, rotate to a system-user token" : ""}`);
console.log(`app id:                 ${d.app_id ?? "?"}${d.application ? `  (${d.application})` : ""}`);
console.log(`${type === "SYSTEM_USER" ? "system-user id:" : "user id:        "}        ${d.profile_id ?? d.user_id ?? "?"}`);
console.log(`expires_at:             ${fmtTs(d.expires_at)}`);
console.log(`data_access_expires_at: ${fmtTs(d.data_access_expires_at)}`);
console.log(`scopes (${scopes.length}):             ${scopes.join(", ") || "none"}`);

if (!d.is_valid) {
  console.log("\n✗ Token is INVALID/EXPIRED — regenerate per docs/META-ADS-SETUP.md §2 and update .env.local + Vercel.");
  process.exit(1);
}
if (missing.length) {
  console.log(`\n⚠ Missing required scope(s): ${missing.join(", ")} — re-generate with these granted (docs/META-ADS-SETUP.md §2).`);
}
console.log("\n── DRY RUN — nothing changed. ──");
