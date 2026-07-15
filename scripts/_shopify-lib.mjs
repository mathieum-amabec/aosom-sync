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

// Theme roles verified via GET /admin/api/2025-01/themes.json (source of truth, 2026-07-14):
//   160944193641 "DRAFT CONVERSION 2026-07-13"        → role:main        (LIVE / published — name still says DRAFT!)
//   160970178665 "DRAFT DE TRAVAIL 2026-07-14"        → role:unpublished (active working DRAFT — themeDuplicate of the live, 2026-07-14)
//   160945012841 "DRAFT DE TRAVAIL 2026-07-13"        → role:unpublished (PREVIOUS working DRAFT — backup)
//   160749813865 "DRAFT DE TRAVAIL 2026-07-05"        → role:unpublished (older previous live — rollback target)
//   160656818281 "Copie de LIVE NOW"                  → role:unpublished (older backup)
// Roles MOVE on every publish: on 2026-07-13, 160944193641 was published to LIVE (demoting
// 160749813865). On 2026-07-14 a fresh full copy of the live, 160970178665, was made the
// working DRAFT via GraphQL themeDuplicate (previous draft 160945012841 kept as backup).
// NOTE: theme NAMES are misleading (the LIVE one is named "DRAFT CONVERSION") — do NOT
// eyeball by name; trust the role from themes.json.
// Re-verify via themes.json after ANY publish — a stale LIVE_THEME_ID makes the apply-*.mjs
// guard "protect" the wrong theme, and a stale DRAFT_THEME_ID can point writes at production.
// IMPORTANT: the LIVE_THEME_ID guard in apply-*.mjs ("refusing to run against the LIVE
// theme") only protects production when this is the REAL published theme. Keep it current.
export const LIVE_THEME_ID = "160944193641"; // current main / published (LIVE) theme — NEVER write here
export const DRAFT_THEME_ID = "160970178665"; // active unpublished DRAFT (dup'd 2026-07-14) — safe write target
export const BACKUP_THEME_ID = "160945012841"; // previous working draft, now backup / rollback target
// Deprecated alias kept for older imports. Points at a non-live theme so the default
// asset-write target can never hit production. New code should use DRAFT_THEME_ID.
export const PREVIEW_THEME_ID = BACKUP_THEME_ID;
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
