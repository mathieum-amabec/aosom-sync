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

// Theme roles verified via GET /admin/api/2025-01/themes.json (source of truth, 2026-08-30):
//   161562099817 "DRAFT DE TRAVAIL 2026-08-08"        → role:main        (LIVE / published — name still says DRAFT!)
//   161529233513 "DRAFT GOOGLE SHOPPING 2026-08-07"   → role:unpublished (live 08-18 → 08-30 — newest non-live)
//   161069989993 "DRAFT DE TRAVAIL 2026-07-18 v2"     → role:unpublished (two-step rollback target)
//   161090928745 "DRAFT DE TRAVAIL 2026-07-19"        → role:unpublished (POISONED — see warning below)
// Roles MOVE on every publish, and the SAME id cycles in and out of LIVE: 161562099817 was
// live 08-08 → 08-18, was demoted when 161529233513 was published, and was published again
// on 2026-08-30 (Halloween seasonal band + seasonal collections). Nothing here may be
// inferred from history — re-read themes.json.
// NOTE: theme NAMES are misleading (every one is named "DRAFT", including the LIVE one) —
// do NOT eyeball by name; trust the role from themes.json.
// There is nothing left to "keep current" here: every id below is read from themes.json on
// use. The failure this removes was real — a constant that drifted since the last publish
// made the apply-*.mjs guard protect a theme that was no longer live.
// The ids are NO LONGER hardcoded. They are resolved from themes.json at call time by
// getLiveThemeId() / getDraftThemeId() / getBackupThemeId() below. Three separate PRs
// (#411, #424, #441) existed only to re-point these constants after a publish; resolving
// them removes that chore, and with it the window where a stale constant is believed.
// DRAFT and BACKUP stay DISTINCT themes, giving a real two-step rollback ladder:
// LIVE 161562099817 → back one publish to DRAFT 161529233513 → back two to BACKUP 161069989993.
// They were the same id between 2026-08-07 and 2026-08-09, which meant "roll back" and
// "write here" pointed at one theme and a bad write destroyed the only rollback point.
// ⚠️ Do NOT use 161090928745 ("DRAFT DE TRAVAIL 2026-07-19"). It predates the 2026-07-21
// live edits, so it is missing the Judge.me app embed and several product-page block
// settings; publishing or branching from it silently reverts them.
//
// ROOT CAUSE of the recurring themeDuplicate failure, finally identified 2026-08-30:
// the shop is at Shopify's hard cap of 20 themes. `POST /admin/api/2025-01/themes.json`
// answers 422 {"errors":{"base":["A shop may only have 20 themes"]}}, and the GraphQL
// `themeDuplicate` mutation hits the same cap but fails SILENTLY — it returns
// { newTheme: null, userErrors: [] } and creates nothing (reproduced 3× on 2026-08-30,
// matching 2026-08-07 and 2026-08-18). It is NOT a broken API. Note the payload field is
// `newTheme`, not `theme` — querying `theme` is a schema error, a separate trap.
// To get a real dedicated draft: DELETE one obsolete theme to free a slot, then duplicate.
//
// ⚠️ The DRAFT is typically the PREVIOUS LIVE, not a fresh copy of the current one. As of the
// 2026-08-30 publish it is 6 assets behind: it lacks sections/lc-seasonal-band.liquid and
// is older on templates/index.json, locales/en.default.json, locales/fr.json,
// sections/main-product.liquid and snippets/agentic-faq.liquid. Writing there is safe;
// publishing it as-is would revert those.
//
// Before ANY publish, checksum-diff the candidate against the current live — the assets
// index carries a per-asset checksum, so it is one request per theme. This caught the
// 2026-08-30 publish: the draft was missing snippets/lc_judgeme_all_reviews.liquid and the
// lc_jm_all_reviews homepage section entirely, and was 9 days stale on card-product.liquid
// (Judge.me star badge) and mega-menu.liquid (bilingual "Voir tout"). All four were ported
// live → draft BEFORE publishing, so the publish moved only forwards. It also caught the
// 2026-08-18 publish: lc-structured-data.liquid was 12 days older than live's and would
// have reverted priceValidUntil from 30 days back to a year.
// Deprecated alias kept for older imports. Resolves DRAFT, not BACKUP: this is a WRITE
// target, and BACKUP is the deeper rollback point — pointing writes there would corrupt the
// very snapshot we roll back to. New code should call getDraftThemeId directly.
export const getPreviewThemeId = getDraftThemeId;
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

export async function getAsset(key, themeId) {
  themeId ??= await getDraftThemeId();
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
 *
 * Cached for the life of the process, which bounds what the guard can promise: a publish
 * that happens mid-run is not seen by later writes in that same run. Scripts here are short
 * and operator-launched, so that window is acceptable; re-running picks up the new roles.
 */
export async function themeRoles() {
  const themes = await listThemes();
  return new Map(themes.map((t) => [t.id, { role: t.role, name: t.name }]));
}

/**
 * Full theme list with updated_at, fetched once per process (same cache discipline as
 * themeRoles: a publish mid-run is not seen by later calls in that run).
 */
let _themesPromise = null;
export async function listThemes() {
  if (!_themesPromise) {
    _themesPromise = rest("/themes.json?fields=id,name,role,updated_at")
      .then(async (res) => {
        if (!res.ok) throw new Error(`themes.json failed: ${res.status} ${await res.text()}`);
        const { themes } = await res.json();
        return themes.map((t) => ({ id: String(t.id), name: t.name, role: t.role, updated_at: t.updated_at }));
      })
      .catch((err) => {
        _themesPromise = null; // a transient failure must not poison every later call
        throw err;
      });
  }
  return _themesPromise;
}

/** Render a theme list for an error message — names are misleading, so always show role + date. */
function formatThemes(themes) {
  return themes.map((t) => `  ${t.id}  ${String(t.role).padEnd(12)} ${t.updated_at ?? "?"}  ${t.name}`).join("\n");
}

/**
 * The id of the PUBLISHED theme, straight from Shopify. Never write here.
 *
 * Throws — loudly, with the full list — when the answer is not exactly one theme. Zero means
 * the token is scoped to the wrong shop or the API shape changed; more than one is impossible
 * per Shopify's model and means we are reading something we do not understand. Either way,
 * guessing would hand a write target to a caller that asked "which theme is live?", so the
 * only safe answer is to stop.
 */
export async function getLiveThemeId() {
  const themes = await listThemes();
  const main = themes.filter((t) => t.role === "main");
  if (main.length === 0) {
    throw new Error(
      `getLiveThemeId: no theme has role "main" on ${STORE}. ` +
        `Cannot identify the live theme, so nothing may be treated as safe to write.\n${formatThemes(themes)}`,
    );
  }
  if (main.length > 1) {
    throw new Error(
      `getLiveThemeId: ${main.length} themes claim role "main" on ${STORE} (${main.map((t) => t.id).join(", ")}). ` +
        `Shopify allows exactly one; refusing to pick.\n${formatThemes(themes)}`,
    );
  }
  return main[0].id;
}

/** Unpublished themes, newest first. The ranking that DRAFT and BACKUP are read off. */
async function unpublishedByRecency() {
  const themes = await listThemes();
  return themes
    .filter((t) => t.role === "unpublished")
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
}

/**
 * The active working DRAFT: the most recently updated unpublished theme.
 *
 * Recency is the only signal Shopify gives us — the names are all "DRAFT DE TRAVAIL <date>",
 * including the live one, so they cannot be trusted. When the top two share an updated_at the
 * ranking is a coin flip, so this throws with the full list rather than pick: an operator
 * passing `{ themeId }` after reading that list is the intended escape hatch.
 */
export async function getDraftThemeId({ themeId } = {}) {
  const candidates = await unpublishedByRecency();
  if (themeId) return assertUnpublishedChoice(themeId, candidates);
  if (candidates.length === 0) {
    throw new Error(`getDraftThemeId: no unpublished theme on ${STORE} — there is nowhere safe to write.`);
  }
  if (candidates.length > 1 && candidates[0].updated_at === candidates[1].updated_at) {
    throw new Error(
      `getDraftThemeId: cannot tell DRAFT apart — the two newest unpublished themes share ` +
        `updated_at ${candidates[0].updated_at}. Pass { themeId } after checking this list:\n${formatThemes(candidates)}`,
    );
  }
  return candidates[0].id;
}

/**
 * The deeper rollback point: the second most recently updated unpublished theme.
 *
 * Ambiguity is the norm here, not the exception — old drafts sit untouched for weeks and end
 * up sharing an updated_at, and at least one theme on this shop is known-poisoned (it predates
 * the 2026-07-21 live edits and silently reverts the Judge.me embed). So this refuses to guess
 * whenever the 2nd place is tied, and asks for an explicit `{ themeId }`.
 */
export async function getBackupThemeId({ themeId } = {}) {
  const candidates = await unpublishedByRecency();
  if (themeId) return assertUnpublishedChoice(themeId, candidates);
  if (candidates.length < 2) {
    throw new Error(
      `getBackupThemeId: need at least 2 unpublished themes for a rollback ladder, found ${candidates.length}.`,
    );
  }
  const tied = candidates.filter((t) => t.updated_at === candidates[1].updated_at);
  if (tied.length > 1) {
    throw new Error(
      `getBackupThemeId: ${tied.length} unpublished themes share updated_at ${candidates[1].updated_at}, ` +
        `so the rollback point is ambiguous. Pass { themeId } after checking this list:\n${formatThemes(candidates)}`,
    );
  }
  return candidates[1].id;
}

/** Accept an operator-supplied id only if it is genuinely an unpublished theme on this shop. */
function assertUnpublishedChoice(themeId, candidates) {
  const hit = candidates.find((t) => t.id === String(themeId));
  if (!hit) {
    throw new Error(
      `Theme ${themeId} is not an unpublished theme on ${STORE}. Unpublished themes:\n${formatThemes(candidates)}`,
    );
  }
  return hit.id;
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

export async function putAsset(key, value, themeId) {
  themeId ??= await getDraftThemeId();
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
