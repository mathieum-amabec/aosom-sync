// Ad-hoc Shopify Admin API helper for the hero/carousel polish session.
// Plain ESM (.mjs) so it runs under node x64 with global fetch — no TS loader needed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadEnv() {
  const raw = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  return env;
}

export const STORE = "27u5y2-kp.myshopify.com";
export const API_VERSION = "2025-01";

// Theme roles verified via GET /admin/api/2025-01/themes.json (source of truth, 2026-08-09):
//   161562099817 "DRAFT DE TRAVAIL 2026-08-08"        → role:main        (LIVE / published — name still says DRAFT!)
//   161529233513 "DRAFT GOOGLE SHOPPING 2026-08-07"   → role:unpublished (previous live, demoted 2026-08-08 — newest non-live)
//   161069989993 "DRAFT DE TRAVAIL 2026-07-18 v2"     → role:unpublished (live until 2026-08-07 — two-step rollback target)
//   161090928745 "DRAFT DE TRAVAIL 2026-07-19"        → role:unpublished (POISONED — see warning below)
// Roles MOVE on every publish: 161069989993 was live until 2026-08-07, when 161529233513 was
// published over it; 161562099817 was then published on 2026-08-08, demoting 161529233513.
// NOTE: theme NAMES are misleading (every one of them is named "DRAFT", including the LIVE
// one) — do NOT eyeball by name; trust the role from themes.json.
// Re-verify via themes.json after ANY publish — a stale LIVE_THEME_ID makes the apply-*.mjs
// guard "protect" the wrong theme, and a stale DRAFT_THEME_ID can point writes at production.
// IMPORTANT: the LIVE_THEME_ID guard in apply-*.mjs ("refusing to run against the LIVE
// theme") only protects production when this is the REAL published theme. Keep it current.
export const LIVE_THEME_ID = "161562099817"; // main / published (LIVE) — NEVER write here
export const DRAFT_THEME_ID = "161529233513"; // newest non-live (previous live) — safe write target, closest to LIVE
export const BACKUP_THEME_ID = "161069989993"; // live until 2026-08-07 — deeper rollback, one publish older than DRAFT
// DRAFT and BACKUP are now DISTINCT themes, giving a real two-step rollback ladder:
// LIVE 161562099817 → back one publish to DRAFT 161529233513 → back two to BACKUP 161069989993.
// They were the same id between 2026-08-07 and 2026-08-09, which meant "roll back" and
// "write here" pointed at one theme and a bad write destroyed the only rollback point.
// ⚠️ Do NOT use 161090928745 ("DRAFT DE TRAVAIL 2026-07-19"). It predates the 2026-07-21
// live edits, so it is missing the Judge.me app embed and several product-page block
// settings; publishing or branching from it silently reverts them.
//
// Shopify refused `themeDuplicate` against the freshly published theme (newTheme: null, no
// userErrors, retried), so there is no dedicated working draft right now. Duplicate
// LIVE_THEME_ID before the next substantial theme change and re-point DRAFT_THEME_ID at it.
// Deprecated alias kept for older imports. Points at a non-live theme so the default
// asset-write target can never hit production. New code should use DRAFT_THEME_ID.
// Aliases DRAFT, not BACKUP: this is a WRITE target, and BACKUP is now a distinct, older
// theme kept as the deeper rollback point. Pointing writes there would corrupt the very
// snapshot we roll back to. (It aliased BACKUP while the two ids were identical.)
export const PREVIEW_THEME_ID = DRAFT_THEME_ID;
const TOKEN = loadEnv().SHOPIFY_ACCESS_TOKEN;

export async function rest(endpoint, options = {}) {
  const url = `https://${STORE}/admin/api/${API_VERSION}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
      ...(options.headers || {}),
    },
  });
  if (res.status === 429) {
    const wait = Math.min(parseFloat(res.headers.get("Retry-After") || "2"), 30);
    await sleep(wait * 1000);
    return rest(endpoint, options);
  }
  return res;
}

export async function gql(query, variables = {}) {
  const res = await rest("/graphql.json", { method: "POST", body: JSON.stringify({ query, variables }) });
  const json = await res.json();
  if (json.errors) throw new Error("GraphQL errors: " + JSON.stringify(json.errors));
  return json;
}

export async function getAsset(key, themeId = BACKUP_THEME_ID) {
  const res = await rest(`/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`getAsset ${key} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.asset.value;
}

export async function putAsset(key, value, themeId = BACKUP_THEME_ID) {
  const res = await rest(`/themes/${themeId}/assets.json`, {
    method: "PUT",
    body: JSON.stringify({ asset: { key, value } }),
  });
  if (!res.ok) throw new Error(`putAsset ${key} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
