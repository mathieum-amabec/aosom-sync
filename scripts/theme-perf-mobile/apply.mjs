// node scripts/theme-perf-mobile/apply.mjs <themeId> [--apply]   (dry-run by default; run from the repo root)
// Applied to the live theme 164012916841 on 2026-11-04 (backup 164084482153). Idempotent: an edit already present is skipped.
import { rest } from "../_shopify-lib.mjs";
import { EDITS, NEW_FILES } from "./edits.mjs";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { dirname, join } from "path";

const [themeId, flag] = process.argv.slice(2);
const APPLY = flag === "--apply";
if (!themeId) throw new Error("themeId required");
const out = join(".context/perf/applied", themeId);

async function get(key) {
  const r = await rest(`/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${key} ${r.status}`);
  return (await r.json()).asset.value;
}
async function put(key, value) {
  const r = await rest(`/themes/${themeId}/assets.json`, { method: "PUT", body: JSON.stringify({ asset: { key, value } }), headers: { "Content-Type": "application/json" } });
  if (!r.ok) throw new Error(`PUT ${key} ${r.status} ${await r.text()}`);
}
function save(rel, v) { const p = join(out, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, v); }

// new files first (theme.liquid renders lc-card-swatch-js)
for (const key of NEW_FILES) {
  const v = readFileSync(join("shopify-theme", key), "utf8");
  const cur = await get(key);
  console.log(key, cur === v ? "unchanged" : cur == null ? "CREATE" : "UPDATE");
  if (APPLY && cur !== v) await put(key, v);
}
for (const [key, edits] of Object.entries(EDITS)) {
  const orig = await get(key);
  if (orig == null) throw new Error(`missing ${key}`);
  const crlf = orig.includes("\r\n");
  let s = orig.replace(/\r\n/g, "\n");
  for (const [from, to] of edits) {
    if (typeof to === "string" && to && s.includes(to)) { console.log(`  ${key}: edit already applied, skipping`); continue; }
    const n = typeof from === "string" ? s.split(from).length - 1 : (s.match(new RegExp(from.source, from.flags.includes("g") ? from.flags : from.flags + "g")) || []).length;
    const already = typeof to === "string" && to && s.includes(to.trim().slice(0, 60));
    if (n === 0 && (already || to === "")) { console.log(`  ${key}: edit already applied, skipping`); continue; }
    if (n !== 1) {
      throw new Error(`${key}: anchor matched ${n}× (expected 1)${already ? " — looks ALREADY APPLIED" : ""}: ${String(from).slice(0, 90)}`);
    }
    s = s.replace(from, () => to);
  }
  if (crlf) s = s.replace(/\n/g, "\r\n");
  save("before/" + key, orig); save("after/" + key, s);
  console.log(key, `${orig.length} → ${s.length} bytes`, APPLY ? "PUT" : "(dry)");
  if (APPLY) await put(key, s);
}
console.log(APPLY ? "applied to " + themeId : "dry run OK");
