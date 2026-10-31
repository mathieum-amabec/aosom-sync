#!/usr/bin/env node
/**
 * SEO / AI-search audit 2026-10-31 — theme side. Pushes the 3 edited files from shopify-theme/ to an
 * UNPUBLISHED draft theme (assertWritableTheme refuses live):
 *   - layout/theme.liquid            wrong-language blog pages → real lang + noindex,follow; policy meta description
 *   - snippets/lc-structured-data    ProductGroup + one Offer per variant; breadcrumb skips promo collections
 *   - snippets/meta-tags             og:locale; og:price = selected variant (matches JSON-LD)
 *
 * Safety: a file is written only if the draft's current copy is byte-identical (modulo line endings) to the
 * live baseline those edits were made on (commit 54d5d3e = live theme 163876372585 on 2026-10-31). Make the draft
 * with themeDuplicate of the CURRENT live theme right before running this.
 *
 *   node-x64 --env-file=.env.local scripts/apply-seo-audit-theme-2026-10-31.mjs --theme=<draftId>          # dry-run
 *   node-x64 --env-file=.env.local scripts/apply-seo-audit-theme-2026-10-31.mjs --theme=<draftId> --apply
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { getAsset, putAsset, assertWritableTheme, loadEnv } from "./_shopify-lib.mjs";

loadEnv();
const APPLY = process.argv.includes("--apply");
const themeId = process.argv.find((a) => a.startsWith("--theme="))?.slice(8);
if (!themeId) throw new Error("--theme=<unpublished draft id> is required");
await assertWritableTheme(themeId);

const BASE = "54d5d3e";
const FILES = ["layout/theme.liquid", "snippets/lc-structured-data.liquid", "snippets/meta-tags.liquid"];
const norm = (s) => s.replace(/\r\n/g, "\n").trimEnd();

let ok = true;
const plan = [];
for (const key of FILES) {
  const baseline = execFileSync("git", ["show", `${BASE}:shopify-theme/${key}`], { encoding: "utf8" });
  const next = fs.readFileSync(`shopify-theme/${key}`, "utf8");
  const current = await getAsset(key, themeId);
  // A file already equal to the new version was written by an earlier, interrupted --apply.
  if (norm(current) === norm(next)) { console.log(`${key}: already applied`); continue; }
  const same = norm(current) === norm(baseline);
  console.log(`${key}: draft ${same ? "matches" : "DIFFERS FROM"} the live baseline · change ${norm(next) === norm(baseline) ? "none" : "ready"}`);
  if (!same) ok = false;
  plan.push({ key, next });
}
if (!ok) {
  console.error("\nAborting: the draft is not a fresh copy of the live baseline. Duplicate the current live theme and retry.");
  process.exit(1);
}
if (!APPLY) {
  console.log("\nDRY-RUN — nothing written.");
  process.exit(0);
}
for (const { key, next } of plan) {
  await putAsset(key, next, themeId);
  // Shopify can serve the previous version for a few seconds after a PUT: retry before failing.
  let back = "";
  for (let i = 0; i < 5 && norm(back) !== norm(next); i++) {
    if (i) await new Promise((r) => setTimeout(r, 3000));
    back = await getAsset(key, themeId);
  }
  if (norm(back) !== norm(next)) throw new Error(`read-back mismatch on ${key}`);
  console.log(`✔ ${key}`);
}
console.log(`\nAPPLIED to draft ${themeId}. Preview: https://ameublodirect.ca/?preview_theme_id=${themeId}`);
