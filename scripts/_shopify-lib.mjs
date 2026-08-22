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

// Theme roles verified via GET /admin/api/2025-01/themes.json (source of truth, 2026-08-18):
//   161529233513 "DRAFT GOOGLE SHOPPING 2026-08-07"   → role:main        (LIVE / published — name still says DRAFT!)
//   161562099817 "DRAFT DE TRAVAIL 2026-08-08"        → role:unpublished (live 08-08 → 08-18 — newest non-live)
//   161069989993 "DRAFT DE TRAVAIL 2026-07-18 v2"     → role:unpublished (live until 2026-08-07 — two-step rollback target)
//   161090928745 "DRAFT DE TRAVAIL 2026-07-19"        → role:unpublished (POISONED — see warning below)
// Roles MOVE on every publish: 161069989993 was live until 2026-08-07, when 161529233513 was
// published over it; 161562099817 was then published on 2026-08-08, demoting 161529233513;
// on 2026-08-18 161529233513 was published again (Judge.me homepage widget, card star badge,
// trustbar reviews benefit), demoting 161562099817. The same id can therefore be LIVE, then
// not, then LIVE again — which is exactly why nothing here may be inferred from history.
// NOTE: theme NAMES are misleading (every one of them is named "DRAFT", including the LIVE
// one) — do NOT eyeball by name; trust the role from themes.json.
// Re-verify via themes.json after ANY publish — a stale LIVE_THEME_ID makes the apply-*.mjs
// guard "protect" the wrong theme, and a stale DRAFT_THEME_ID can point writes at production.
// IMPORTANT: the LIVE_THEME_ID guard in apply-*.mjs ("refusing to run against the LIVE
// theme") only protects production when this is the REAL published theme. Keep it current.
export const LIVE_THEME_ID = "161529233513"; // main / published (LIVE) since 2026-08-18 — NEVER write here
export const DRAFT_THEME_ID = "161562099817"; // live 08-08 → 08-18 — safe write target, closest to LIVE
export const BACKUP_THEME_ID = "161069989993"; // live until 2026-08-07 — deeper rollback, one publish older than DRAFT
// DRAFT and BACKUP stay DISTINCT themes, giving a real two-step rollback ladder:
// LIVE 161529233513 → back one publish to DRAFT 161562099817 → back two to BACKUP 161069989993.
// They were the same id between 2026-08-07 and 2026-08-09, which meant "roll back" and
// "write here" pointed at one theme and a bad write destroyed the only rollback point.
// ⚠️ Do NOT use 161090928745 ("DRAFT DE TRAVAIL 2026-07-19"). It predates the 2026-07-21
// live edits, so it is missing the Judge.me app embed and several product-page block
// settings; publishing or branching from it silently reverts them.
//
// ⚠️ DRAFT_THEME_ID is the PREVIOUS LIVE, not a fresh copy of the current one: as of the
// 2026-08-18 publish it is 4 assets behind (card-product.liquid, mega-menu.liquid,
// templates/index.json, and it lacks snippets/lc_judgeme_all_reviews.liquid). Writing there
// is safe, but publishing it would revert those. `themeDuplicate` against the freshly
// published theme failed again on 2026-08-18 (newTheme: null, no userErrors, retried twice
// plus a 2-minute poll — theme count stayed at 20), the same way it did on 2026-08-07, so
// there is still no dedicated working draft. Duplicate LIVE_THEME_ID from the Shopify admin
// UI before the next substantial theme change and re-point DRAFT_THEME_ID at it.
//
// Before ANY publish, checksum-diff the candidate against the current live — the assets
// index carries a per-asset checksum, so it is one request per theme. The 2026-08-18 publish
// was caught this way: the draft's lc-structured-data.liquid was 12 days older than live's
// and would have reverted priceValidUntil from 30 days back to a year.
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
