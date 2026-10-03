#!/usr/bin/env tsx
/**
 * scripts/costway-import.mts — Costway pilot import (appliances: dehumidifiers, washers, dryers).
 *
 *   prepare   pick the best candidates by margin, write the copy, run every gate, save a plan file.
 *             No Shopify write (it does spend LLM tokens and writes the usual image-verdict cache).
 *   apply     create the prepared products on Shopify as DRAFTS (dry run unless --apply).
 *
 *   node-x64 --env-file=<main clone>/.env.local node_modules/tsx/dist/cli.mjs scripts/costway-import.mts prepare --limit 50 --batch pilot-1 --plan costway-plan.json
 *   node-x64 --env-file=… scripts/costway-import.mts apply --plan costway-plan.json [--only 123,456] [--max-minutes 9] [--apply]
 *
 * apply is resumable: an item already linked in costway_products is skipped, so re-run until done.
 * Nothing is ever published by this script — the products stay DRAFT until Mat publishes them.
 */
import fs from "node:fs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const has = (n: string) => argv.includes(n);
const PLAN = flag("--plan") ?? "costway-plan.json";
const BATCH = flag("--batch") ?? "pilot-1";

async function main() {
  if (cmd !== "prepare" && cmd !== "apply") { console.error("usage: costway-import.mts prepare|apply [flags]"); process.exit(1); }
  const { ensureSchema } = await import("@/lib/database");
  const db = await ensureSchema();
  const imp = await import("@/lib/costway/importer");

  if (cmd === "prepare") {
    const limit = Number(flag("--limit") ?? "50");
    const minQty = Number(flag("--min-qty") ?? "10");
    const { generateProductContent, sanitizeHtml, stripSupplierBrands } = await import("@/lib/content-generator");
    const { enforceCleanPrimaryImage } = await import("@/lib/image-compliance-audit");
    const { runQualityGates } = await import("@/lib/import-quality-gates");

    // Over-select: some candidates will be rejected by a gate, and we still want `limit` ready ones.
    const candidates = await imp.selectCandidates(db, { limit: Math.ceil(limit * 1.4), minQty });
    console.log(`\n🛒 prepare — ${candidates.length} candidates (target ${limit}) by margin, minQty=${minQty}\n`);

    const deps: import("@/lib/costway/importer").PrepareDeps = {
      generate: generateProductContent,
      guardImages: async (urls) => { const g = await enforceCleanPrimaryImage(urls); return { images: g.images, outcome: g.outcome }; },
      qualityGates: async (images, content) => { const r = await runQualityGates(images, content); return { failures: r.failures }; },
      cleanHtml: (h) => sanitizeHtml(stripSupplierBrands(h)),
    };

    const prepared: import("@/lib/costway/importer").PreparedItem[] = [];
    let ready = 0;
    for (const c of candidates) {
      if (ready >= limit) break;
      try {
        const p = await imp.prepareCandidate(c, deps);
        prepared.push(p);
        if (!p.problems.length) ready++;
        console.log(`${p.problems.length ? "✗" : "✓"} ${c.itemNo.padEnd(10)} ${p.kind.padEnd(12)} ${String(p.margin.sell).padStart(7)}$ marge ${String(p.margin.dollars).padStart(6)}$ ${p.stockOrigin} | ${p.content.titleFr.slice(0, 60)}${p.problems.length ? "  ⚠ " + p.problems.join("; ") : ""}`);
      } catch (e) {
        console.log(`✗ ${c.itemNo} prepare failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    fs.writeFileSync(PLAN, JSON.stringify({ batch: BATCH, createdAt: new Date().toISOString(), items: prepared }, null, 1));
    console.log(`\nplan → ${PLAN}: ${ready} ready, ${prepared.length - ready} blocked`);
    return;
  }

  // ── apply ──
  const plan = JSON.parse(fs.readFileSync(PLAN, "utf8")) as { batch: string; items: import("@/lib/costway/importer").PreparedItem[] };
  const only = flag("--only")?.split(",").map((s) => s.trim());
  const maxMs = Number(flag("--max-minutes") ?? "9") * 60_000;
  const APPLY = has("--apply");
  const items = plan.items.filter((p) => !only || only.includes(p.itemNo));
  console.log(`\n🛒 apply — ${items.length} item(s), batch ${plan.batch} — ${APPLY ? "APPLY (drafts)" : "DRY RUN"}\n`);

  const sc = await import("@/lib/shopify-client");
  const { SOURCE_TAG } = await import("@/lib/costway/taxonomy");
  const deps: import("@/lib/costway/importer").ApplyDeps = {
    db,
    now: () => Math.floor(Date.now() / 1000),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    createProduct: (merged, content) => sc.createShopifyProduct(merged, content, { status: "draft", images: [], extraTags: [SOURCE_TAG] }),
    downloadImage: async (url) => {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`download ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 2_000) throw new Error("image too small");
      return buf.toString("base64");
    },
    uploadImage: async (productId, img) => {
      const res = await sc.shopifyFetch(`/products/${productId}/images.json`, { method: "POST", body: JSON.stringify({ image: img }) });
      if (!res.ok) throw new Error(`upload ${res.status} ${(await res.text()).slice(0, 120)}`);
    },
    getProduct: async (id) => {
      const res = await sc.shopifyFetch(`/products/${id}.json?fields=id,handle,status,tags,vendor,product_type,title,body_html,variants,images`);
      if (!res.ok) throw new Error(`get product ${res.status}`);
      const p = (await res.json()).product;
      return {
        id: String(p.id), handle: p.handle, status: p.status, vendor: p.vendor, productType: p.product_type, title: p.title, bodyHtml: p.body_html ?? "",
        tags: String(p.tags ?? "").split(",").map((t: string) => t.trim()).filter(Boolean),
        variants: (p.variants ?? []).map((v: Record<string, unknown>) => ({ id: String(v.id), sku: String(v.sku ?? ""), inventoryItemId: String(v.inventory_item_id), option1: (v.option1 as string) ?? null })),
        images: (p.images ?? []).map((i: Record<string, unknown>) => ({ id: String(i.id), src: String(i.src), alt: (i.alt as string) ?? null })),
      };
    },
    attachVariantImages: (created, merged) => sc.attachVariantImages(created, merged),
    trackInventory: async (inventoryItemId, qty) => {
      await sc.enableVariantTracking(inventoryItemId);
      await sc.setInventoryLevel(inventoryItemId, await sc.getPrimaryLocationId(), qty);
    },
  };

  const t0 = Date.now();
  let ok = 0, fail = 0;
  const log = fs.createWriteStream(PLAN.replace(/\.json$/, "") + ".results.jsonl", { flags: "a" });
  for (const p of items) {
    if (Date.now() - t0 > maxMs) { console.log(`⏱  time budget reached — re-run apply to continue (imported items are skipped)`); break; }
    if (!APPLY) { console.log(`DRY ${p.itemNo} ${p.kind} ${p.variants.length}v ${p.imageUrls.length}img  ${p.content.titleFr}${p.problems.length ? "  ⚠ " + p.problems.join("; ") : ""}`); continue; }
    const r = await imp.applyPrepared(p, plan.batch, deps);
    log.write(JSON.stringify({ ...r, at: new Date().toISOString() }) + "\n");
    if (r.ok) ok++; else fail++;
    console.log(`${r.ok ? "✓" : "✗"} ${p.itemNo} ${r.ok ? `${r.productId} ${r.handle} img=${r.imagesUploaded}` : r.error}${r.warnings.length ? "  ⚠ " + r.warnings.join(" | ") : ""}`);
  }
  log.end();
  console.log(`\n=== ok=${ok} fail=${fail} ===`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("FATAL:", e); process.exit(1); });
