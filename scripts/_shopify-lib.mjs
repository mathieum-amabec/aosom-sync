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
// Resolved on first request, not at import: reading .env.local eagerly makes the module
// impossible to import anywhere without one (tests included) and turns a missing file into
// a crash at load time rather than at the call that actually needs a token.
let _token = null;
function token() {
  if (_token === null) {
    // The environment wins over .env.local: these scripts are routinely run as
    // `SHOPIFY_ACCESS_TOKEN=… node-x64 scripts/…` from a clone whose .env.local carries a
    // different store's credentials. Reading the file first would silently use the wrong one.
    _token = process.env.SHOPIFY_ACCESS_TOKEN || readEnvFileToken();
    if (!_token) throw new Error("SHOPIFY_ACCESS_TOKEN not set (env or .env.local)");
  }
  return _token;
}

function readEnvFileToken() {
  try {
    return loadEnv().SHOPIFY_ACCESS_TOKEN || "";
  } catch {
    return ""; // no .env.local — fine as long as the env var is set
  }
}

export async function rest(endpoint, options = {}) {
  const url = `https://${STORE}/admin/api/${API_VERSION}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token(),
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

/**
 * Live theme roles, straight from Shopify, fetched once per process.
 *
 * The constants above are a cache that goes stale on every publish; this is the truth.
 * Keeping the two separate is the point: the constants say where we MEANT to write, the
 * roles say what that theme actually is right now.
 */
let _rolesPromise = null;
export async function themeRoles() {
  if (!_rolesPromise) {
    _rolesPromise = rest("/themes.json?fields=id,name,role")
      .then(async (res) => {
        if (!res.ok) throw new Error(`themes.json failed: ${res.status} ${await res.text()}`);
        const { themes } = await res.json();
        return new Map(themes.map((t) => [String(t.id), { role: t.role, name: t.name }]));
      })
      .catch((err) => {
        _rolesPromise = null; // a transient failure must not poison every later call
        throw err;
      });
  }
  return _rolesPromise;
}

/**
 * Refuse to write unless `themeId` is an existing, UNPUBLISHED theme.
 *
 * This is the guard that 19 of the 38 writing scripts had and the other 19 did not, now
 * enforced once at the choke point instead of copy-pasted per script. It deliberately asks
 * Shopify rather than comparing against LIVE_THEME_ID: a constant that has drifted since the
 * last publish would "protect" the wrong theme, which is precisely the failure it exists to
 * stop.
 *
 * Deliberate writes to the published theme go through `putAssetToPublishedTheme`.
 */
export async function assertWritableTheme(themeId) {
  const roles = await themeRoles();
  const entry = roles.get(String(themeId));
  if (!entry) {
    throw new Error(
      `Refusing to write: theme ${themeId} does not exist on ${STORE}. ` +
        `The id is probably stale — re-check themes.json and update _shopify-lib.`,
    );
  }
  if (entry.role !== "unpublished") {
    throw new Error(
      `Refusing to write to theme ${themeId} ("${entry.name}"): its role is "${entry.role}", not "unpublished". ` +
        `Roles move on every publish. If this write is intentional, use putAssetToPublishedTheme.`,
    );
  }
}

export async function putAsset(key, value, themeId = BACKUP_THEME_ID) {
  await assertWritableTheme(themeId);
  return _putAssetUnchecked(key, value, themeId);
}

/**
 * Write to the PUBLISHED theme on purpose. A handful of scripts genuinely target production
 * (the Shop Pay widget fix, the price-alert block). They should say so at the call site
 * rather than get there by a default that nobody re-read.
 */
export async function putAssetToPublishedTheme(key, value, themeId) {
  const roles = await themeRoles();
  const entry = roles.get(String(themeId));
  if (!entry) throw new Error(`Theme ${themeId} does not exist on ${STORE}.`);
  if (entry.role !== "main") {
    throw new Error(
      `putAssetToPublishedTheme: theme ${themeId} ("${entry.name}") has role "${entry.role}", not "main". ` +
        `This script means to edit the live storefront; it will not edit something else instead.`,
    );
  }
  return _putAssetUnchecked(key, value, themeId);
}

async function _putAssetUnchecked(key, value, themeId) {
  const res = await rest(`/themes/${themeId}/assets.json`, {
    method: "PUT",
    body: JSON.stringify({ asset: { key, value } }),
  });
  if (!res.ok) throw new Error(`putAsset ${key} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
