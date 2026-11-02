#!/usr/bin/env node
/**
 * Creates (or updates) the Shopify page /pages/garantie-tranquillite from shopify-theme/pages/garantie-tranquillite.html
 * (lawyer-approved terms, FR + EN). Created HIDDEN (published: false); published at warranty activation.
 *   node-x64 --env-file=.env.local scripts/create-warranty-page.mjs            # dry-run
 *   node-x64 --env-file=.env.local scripts/create-warranty-page.mjs --apply    # create/update, stays hidden
 */
import fs from "node:fs";
import { rest, loadEnv } from "./_shopify-lib.mjs";

loadEnv();
const APPLY = process.argv.includes("--apply");
const HANDLE = "garantie-tranquillite";
const body = fs.readFileSync("shopify-theme/pages/garantie-tranquillite.html", "utf8");
for (const bad of ["[À COMPLÉTER]", "[TO COMPLETE", "[RISQUE]", "[DÉCISION", "[À VÉRIFIER", "Aosom"]) {
  if (body.includes(bad)) throw new Error(`page body still contains "${bad}"`);
}

const list = await (await rest(`/pages.json?handle=${HANDLE}&fields=id,handle,published_at`)).json();
const existing = list.pages?.[0];
console.log(existing ? `existing page ${existing.id} (published_at=${existing.published_at})` : "no existing page", `· body ${body.length} chars`);
if (!APPLY) process.exit(0);

const page = { title: "Garantie Tranquillité", handle: HANDLE, body_html: body };
const res = existing
  ? await rest(`/pages/${existing.id}.json`, { method: "PUT", body: JSON.stringify({ page: { id: existing.id, body_html: body } }) })
  : await rest(`/pages.json`, { method: "POST", body: JSON.stringify({ page: { ...page, published: false } }) });
const json = await res.json();
if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
console.log(`✓ page ${json.page.id} /pages/${json.page.handle} published_at=${json.page.published_at}`);
