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

// Theme roles verified via GET /admin/api/2024-01/themes.json (source of truth, 2026-07-01):
//   160606093417 "Copie de Copie de Copie de Copie de Trade v2"        → role:main        (LIVE / published)
//   160655114345 "Copie de Copie de Copie de Copie de Copie Trade v2"  → role:unpublished (active working DRAFT)
//   160584859753 "Copie de Copie de Copie de Trade v2"                 → role:unpublished (PREVIOUS live — rollback target)
//   160059195497 "Copie de Trade v2"                                   → role:unpublished (older backup)
// On 2026-07-01 the former draft 160606093417 was published to LIVE, demoting 160584859753;
// a fresh copy (160655114345) is the new working DRAFT.
// IMPORTANT: the LIVE_THEME_ID guard in apply-*.mjs ("refusing to run against the LIVE
// theme") only protects production when this is the REAL published theme. Keep it current.
export const LIVE_THEME_ID = "160606093417"; // current main / published (LIVE) theme — NEVER write here
export const DRAFT_THEME_ID = "160655114345"; // active unpublished DRAFT — safe write target
export const BACKUP_THEME_ID = "160059195497"; // older unpublished theme, kept as backup
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
