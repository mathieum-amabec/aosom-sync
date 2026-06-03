#!/usr/bin/env tsx
/**
 * scripts/verify-products.ts — READ-ONLY. GETs title/handle + key SEO metafields
 * for a set of Shopify products, to verify a migration before/after. No writes.
 *
 * Usage: IDS=123,456 tsx --env-file=.env.local scripts/verify-products.ts
 */
import { shopifyFetch } from "@/lib/shopify-client";

const KEYS = ["title_tag", "description_tag", "title_en", "meta_description_fr", "meta_description_en"];

async function main(): Promise<void> {
  const ids = (process.env.IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) { console.error("Set IDS=id1,id2,..."); process.exit(1); }

  for (const id of ids) {
    const pr = await shopifyFetch(`/products/${id}.json?fields=id,title,handle`);
    if (!pr.ok) { console.log(`[${id}] GET failed: ${pr.status}`); continue; }
    const p = (await pr.json()).product;
    const mr = await shopifyFetch(`/products/${id}/metafields.json`);
    const mfs = (((await mr.json()).metafields) || []).filter((m: Record<string, unknown>) => KEYS.includes(String(m.key)));
    console.log(`\n[${id}]`);
    console.log(`  title : ${p.title}`);
    console.log(`  handle: ${p.handle}`);
    for (const m of mfs) console.log(`  mf ${m.namespace}.${m.key} = ${String(m.value).slice(0, 72)}`);
    if (!mfs.length) console.log(`  (no SEO metafields yet)`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
