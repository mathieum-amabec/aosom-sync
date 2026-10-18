#!/usr/bin/env tsx
/**
 * scripts/costway-lifestyle-first.mts — apply the store photo rule to every Costway product already on Shopify:
 * position 1 = a clean lifestyle photo, else the clean studio shot (costway/gallery.ts, same check as the Aosom import).
 *
 *   node-x64 --env-file=<main clone>/.env.local node_modules/tsx/dist/cli.mjs scripts/costway-lifestyle-first.mts           # dry run
 *   node-x64 --env-file=… node_modules/tsx/dist/cli.mjs scripts/costway-lifestyle-first.mts --apply                          # writes
 *   [--only <shopifyId,…>] [--skip N (resume after N products)] [--max-minutes 8]
 *
 * Only the position of one photo changes (PUT image position 1); no photo is deleted, variant photos stay attached.
 * Products where no photo can lead are listed for a human. Resumable: a product already led by its pick is skipped.
 */
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] ?? null : null; };
const only = flag("--only")?.split(",").map((s) => s.trim());
const maxMs = Number(flag("--max-minutes") ?? "8") * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { ensureSchema } = await import("@/lib/database");
  const { lifestyleFirst } = await import("@/lib/costway/gallery");
  const sc = await import("@/lib/shopify-client");
  const db = await ensureSchema();
  const ids = (
    await db.execute(`SELECT DISTINCT shopify_product_id AS id FROM costway_products WHERE shopify_product_id IS NOT NULL AND shopify_product_id != ''`)
  ).rows.map((r) => String(r.id)).filter((id) => !only || only.includes(id)).slice(Number(flag("--skip") ?? "0"));
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${ids.length} Costway product(s)`);

  const t0 = Date.now();
  const tally = { moved: 0, alreadyLifestyle: 0, studio: 0, needsHuman: 0, errors: 0 };
  for (const id of ids) {
    if (Date.now() - t0 > maxMs) { console.log("⏱  time budget reached — re-run to continue"); break; }
    try {
      const res = await sc.shopifyFetch(`/products/${id}/images.json?fields=id,src,position`);
      await sleep(550);
      if (!res.ok) { console.log(`✗ ${id}: HTTP ${res.status}`); tally.errors++; continue; }
      const imgs = ((await res.json()).images ?? []) as Array<{ id: number; src: string; position: number }>;
      imgs.sort((a, b) => a.position - b.position);
      const urls = imgs.map((i) => i.src);
      const g = await lifestyleFirst(urls);
      if (g.outcome === "no_alternative") { console.log(`⚠ ${id}: no photo can lead (${g.reasons.join(",")}) — needs a human`); tally.needsHuman++; continue; }
      const pick = imgs.find((i) => i.src === g.images[0]);
      if (!pick) { tally.errors++; continue; }
      if (pick.position === 1) {
        if (g.outcome === "lifestyle") tally.alreadyLifestyle++; else tally.studio++;
        continue;
      }
      console.log(`${id}: photo ${pick.position} → 1 (${g.outcome}); previous first image ${imgs[0].id}`);
      tally.moved++;
      if (g.outcome === "studio") tally.studio++;
      if (APPLY) {
        const put = await sc.shopifyFetch(`/products/${id}/images/${pick.id}.json`, { method: "PUT", body: JSON.stringify({ image: { id: pick.id, position: 1 } }) });
        if (!put.ok) { console.log(`✗ ${id}: reorder HTTP ${put.status}`); tally.errors++; }
        await sleep(550);
      }
    } catch (e) {
      console.log(`✗ ${id}: ${e instanceof Error ? e.message : e}`);
      tally.errors++;
    }
  }
  console.log(`\n${JSON.stringify(tally)}`);
}

// Charged to the dedicated "import" pool, never the shared "batch" one.
import("@/lib/llm-budget")
  .then(({ withBudgetPool }) => withBudgetPool("import", main))
  .catch((e) => { console.error(e); process.exit(1); });
