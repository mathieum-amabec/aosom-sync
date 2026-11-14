#!/usr/bin/env tsx
/**
 * scripts/costway-publish.mts — take the Costway drafts live (status active + published to the Online Store).
 *
 * Dry run by default. Every product is RE-READ from Shopify and must pass the go-live gates first; one that
 * fails is skipped and reported, never published:
 *   - still a draft carrying the neutral `src-c` tag, vendor "Ameublo Direct";
 *   - every variant SKU is an internal SKU (never the supplier's) and no supplier trace anywhere on it;
 *   - at least 3 images, all with neutral file names;
 *   - at least one variant with sellable stock;
 *   - linked in costway_products (so the Aosom sweeps skip it) — checked via getCostwayShopifyProductIds().
 * After publishing, costway_products.import_status becomes 'active'.
 *
 *   node-x64 --env-file=<main clone>/.env.local node_modules/tsx/dist/cli.mjs scripts/costway-publish.mts [--only 123,456] [--apply]
 *
 * Rollback for one product: unpublishShopifyProduct(id, { deactivate: true }) (published:false + status draft).
 */
const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const APPLY = argv.includes("--apply");
const only = flag("--only")?.split(",").map((s) => s.trim());

async function main() {
  const { ensureSchema, getCostwayShopifyProductIds } = await import("@/lib/database");
  const db = await ensureSchema();
  const sc = await import("@/lib/shopify-client");
  const { isInternalSku, findCostwayLeaks } = await import("@/lib/costway/identity");
  const { SOURCE_TAG } = await import("@/lib/costway/taxonomy");

  const rows = (await db.execute(
    `SELECT shopify_product_id AS pid, GROUP_CONCAT(sku, '|') AS skus, MIN(item_no) AS item_no, MIN(import_status) AS st
       FROM costway_products WHERE shopify_product_id IS NOT NULL GROUP BY shopify_product_id ORDER BY MIN(imported_at), MIN(item_no)`,
  )).rows as unknown as Array<{ pid: string; skus: string; item_no: string; st: string }>;
  const isolated = await getCostwayShopifyProductIds();
  const todo = rows.filter((r) => !only || only.includes(r.item_no) || only.includes(r.pid));
  console.log(`\n🚀 costway-publish — ${todo.length} linked product(s) — ${APPLY ? "APPLY (go live)" : "DRY RUN"}\n`);

  let published = 0, skipped = 0, already = 0;
  for (const r of todo) {
    const res = await sc.shopifyFetch(`/products/${r.pid}.json?fields=id,handle,status,published_at,tags,vendor,title,body_html,product_type,variants,images,options`);
    if (!res.ok) { console.log(`✗ ${r.item_no} read ${res.status}`); skipped++; continue; }
    const p = (await res.json()).product;
    const reasons: string[] = [];
    const supplierSkus = r.skus.split("|");
    if (p.status === "active" && p.published_at) { already++; continue; }
    if (p.status !== "draft") reasons.push(`status ${p.status}`);
    if (!String(p.tags).split(",").map((t: string) => t.trim()).includes(SOURCE_TAG)) reasons.push("no src-c tag");
    if (p.vendor !== "Ameublo Direct") reasons.push(`vendor ${p.vendor}`);
    if (!isolated.has(String(p.id))) reasons.push("NOT in the Aosom-job isolation set");
    if ((p.variants as Array<{ sku: string }>).some((v) => !isInternalSku(v.sku))) reasons.push("non-internal SKU");
    if ((p.images as unknown[]).length < 3) reasons.push(`only ${(p.images as unknown[]).length} images`);
    if ((p.images as Array<{ src: string }>).some((i) => !/\/m[0-9a-z]{7}-\d+\.(jpg|png|webp)/i.test(i.src))) reasons.push("non-neutral image name");
    if (!(p.variants as Array<{ inventory_quantity: number }>).some((v) => v.inventory_quantity > 0)) reasons.push("no sellable stock");
    const surface = JSON.stringify({ t: p.title, b: p.body_html, h: p.handle, tags: p.tags, v: p.vendor, pt: p.product_type, o: p.options, i: (p.images as Array<{ src: string; alt: string }>).map((i) => [i.src, i.alt]) });
    const leaks = findCostwayLeaks(surface, supplierSkus);
    if (leaks.length) reasons.push(`leak: ${leaks.join(", ")}`);

    if (reasons.length) { console.log(`⛔ ${r.item_no} ${p.handle} — SKIPPED: ${reasons.join("; ")}`); skipped++; continue; }
    if (!APPLY) { console.log(`OK  ${r.item_no} ${p.handle}  (${(p.variants as unknown[]).length}v, ${(p.images as unknown[]).length} img) would go live`); continue; }

    await sc.publishShopifyProduct(String(p.id), { activate: true });
    await db.execute({ sql: `UPDATE costway_products SET import_status = 'active' WHERE shopify_product_id = ?`, args: [String(p.id)] });
    published++;
    console.log(`✓ ${r.item_no} ${p.handle} — LIVE`);
    await new Promise((res2) => setTimeout(res2, 550));
  }
  console.log(`\n=== published=${published} skipped=${skipped} already-live=${already} ===`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("FATAL:", e); process.exit(1); });
