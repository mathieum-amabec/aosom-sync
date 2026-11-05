// Minimal Graph API helper for the 2026-11 Meta ads rework. Reads secrets from
// the main checkout's .env.local; never prints them.
import fs from "node:fs";

const ENV_PATH = process.env.AOSOM_ENV || "C:/Users/vente/Documents/aosom-sync/.env.local";
const env = {};
for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
export const TOKEN = env.META_ACCESS_TOKEN;
export const ACT = env.META_AD_ACCOUNT_ID?.startsWith("act_") ? env.META_AD_ACCOUNT_ID : `act_${env.META_AD_ACCOUNT_ID}`;
export const PIXEL = env.NEXT_PUBLIC_META_PIXEL_ID;
export const V = process.env.META_API_VERSION || "v25.0";
const BASE = `https://graph.facebook.com/${V}`;

function scrub(s) { return String(s).split(TOKEN).join("<token>"); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export let lastUsage = null;
async function fetchJson(u, init) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(u, init);
    lastUsage = r.headers.get("x-business-use-case-usage");
    const j = await r.json();
    if (j.error && (j.error.code === 17 || j.error.code === 80004 || j.error.code === 4) && attempt < 8) {
      let wait = 90;
      try { const x = Object.values(JSON.parse(lastUsage || "{}"))[0]?.[0]; if (x?.estimated_time_to_regain_access) wait = Math.max(wait, x.estimated_time_to_regain_access * 60); } catch {}
      console.error(`  rate-limited (code ${j.error.code}), waiting ${wait}s…`);
      await sleep(wait * 1000);
      continue;
    }
    return j;
  }
}

export async function get(path, params = {}) {
  const u = new URL(path.startsWith("http") ? path : `${BASE}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  u.searchParams.set("access_token", TOKEN);
  const j = await fetchJson(u);
  if (j.error) throw new Error(scrub(`GET ${path}: ${JSON.stringify(j.error)}`));
  return j;
}

export async function getAll(path, params = {}) {
  let j = await get(path, { limit: "50", ...params });
  const out = [...(j.data || [])];
  while (j.paging?.next) {
    await sleep(1500);
    j = await fetchJson(j.paging.next);
    if (j.error) throw new Error(scrub(JSON.stringify(j.error)));
    out.push(...(j.data || []));
  }
  return out;
}

export async function post(path, body = {}) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) form.set(k, typeof v === "string" ? v : JSON.stringify(v));
  form.set("access_token", TOKEN);
  const j = await fetchJson(`${BASE}/${path.replace(/^\//, "")}`, { method: "POST", body: form });
  if (j.error) throw new Error(scrub(`POST ${path}: ${JSON.stringify(j.error)}`));
  return j;
}
