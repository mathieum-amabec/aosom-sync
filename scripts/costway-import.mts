#!/usr/bin/env tsx
/**
 * scripts/costway-import.mts — Costway import: big sellers in any category (--mode demand, the default) or the
 * original appliance pilot (--mode appliances). Prices follow pricing.ts (23 % target margin, x.99 endings).
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
  if (cmd !== "prepare" && cmd !== "apply" && cmd !== "repair") { console.error("usage: costway-import.mts prepare|apply|repair [flags]"); process.exit(1); }
  const { ensureSchema } = await import("@/lib/database");
  const db = await ensureSchema();
  const imp = await import("@/lib/costway/importer");

  if (cmd === "prepare") {
    const limit = Number(flag("--limit") ?? "50");
    const minQty = Number(flag("--min-qty") ?? "10");
    const { generateProductContent, sanitizeHtml, stripSupplierBrands } = await import("@/lib/content-generator");
    const { lifestyleFirst } = await import("@/lib/costway/gallery");
    const { runQualityGates } = await import("@/lib/import-quality-gates");

    // Over-select: some candidates will be rejected by a gate, and we still want `limit` ready ones.
    // --mode demand (default since 2026-10-17): any category, big sellers only, ranked by expected margin dollars
    // (Aosom's sales of the matched product type; Costway's own with --costway-history once it has a few weeks).
    // --mode appliances: the original pilot selection (dehumidifiers, washers, dryers), by margin.
    const mode = flag("--mode") ?? "demand";
    let candidates: import("@/lib/costway/importer").Candidate[];
    if (mode === "appliances") {
      candidates = await imp.selectCandidates(db, { limit: Math.ceil(limit * 1.4), minQty });
    } else {
      const { loadAosomTypeDemand } = await import("@/lib/costway/demand");
      const { getCostwayDemand } = await import("@/lib/costway/db");
      candidates = await imp.selectDemandCandidates(db, {
        limit: Math.ceil(limit * 1.4),
        minQty,
        minDemand: Number(flag("--min-demand") ?? "10"),
        // Over-selection (x1.4) keeps the per-type cap meaningful: about 10 ready products per type per 40.
        maxPerType: Math.max(1, Math.ceil(Number(flag("--max-per-type") ?? "10") * 1.4)),
        aosomTypes: await loadAosomTypeDemand(db),
        costwayDemand: has("--costway-history") ? await getCostwayDemand(30) : undefined,
      });
    }
    console.log(`\n🛒 prepare — ${candidates.length} candidates (target ${limit}), mode=${mode}, minQty=${minQty}\n`);

    const deps: import("@/lib/costway/importer").PrepareDeps = {
      generate: generateProductContent,
      // Store rule: a clean LIFESTYLE photo first, the studio shot only when none exists (same check as the Aosom import).
      guardImages: async (urls) => { const g = await lifestyleFirst(urls); return { images: g.images, outcome: g.outcome }; },
      qualityGates: async (images, content) => { const r = await runQualityGates(images, content); return { failures: r.failures }; },
      cleanHtml: (h) => sanitizeHtml(stripSupplierBrands(h)),
    };

    // Resumable: a plan file from a previous (interrupted) run is continued, never redone, and the
    // plan is saved after every item so a budget stop or a crash loses nothing.
    const prepared: import("@/lib/costway/importer").PreparedItem[] = fs.existsSync(PLAN) ? JSON.parse(fs.readFileSync(PLAN, "utf8")).items : [];
    const done = new Set(prepared.map((p) => p.itemNo));
    let ready = prepared.filter((p) => !p.problems.length).length;
    const save = () => fs.writeFileSync(PLAN, JSON.stringify({ batch: BATCH, createdAt: new Date().toISOString(), items: prepared }, null, 1));
    const t0 = Date.now();
    const maxMs = Number(flag("--max-minutes") ?? "9") * 60_000;
    for (const c of candidates) {
      if (ready >= limit) break;
      if (done.has(c.itemNo)) continue;
      if (Date.now() - t0 > maxMs) { console.log("⏱  time budget reached — re-run prepare to continue"); break; }
      try {
        const p = await imp.prepareCandidate(c, deps);
        prepared.push(p);
        save();
        if (!p.problems.length) ready++;
        console.log(`${p.problems.length ? "✗" : "✓"} ${c.itemNo.padEnd(10)} ${p.kind.padEnd(12)} ${String(p.margin.sell).padStart(7)}$ marge ${String(p.margin.dollars).padStart(6)}$ ${p.stockOrigin} | ${p.content.titleFr.slice(0, 60)}${p.problems.length ? "  ⚠ " + p.problems.join("; ") : ""}`);
      } catch (e) {
        console.log(`✗ ${c.itemNo} prepare failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    save();
    console.log(`\nplan → ${PLAN}: ${ready} ready, ${prepared.length - ready} blocked`);
    return;
  }

  // ── apply ──
  const plan = JSON.parse(fs.readFileSync(PLAN, "utf8")) as { batch: string; items: import("@/lib/costway/importer").PreparedItem[] };
  const only = flag("--only")?.split(",").map((s) => s.trim());
  const maxMs = Number(flag("--max-minutes") ?? "9") * 60_000;
  const APPLY = has("--apply");
  const except = flag("--except")?.split(",").map((s) => s.trim()) ?? [];
  const items = plan.items.filter((p) => (!only || only.includes(p.itemNo)) && !except.includes(p.itemNo));
  console.log(`\n🛒 apply — ${items.length} item(s), batch ${plan.batch} — ${APPLY ? "APPLY (drafts)" : "DRY RUN"}\n`);

  const sc = await import("@/lib/shopify-client");
  const { SOURCE_TAG } = await import("@/lib/costway/taxonomy");
  const deps: import("@/lib/costway/importer").ApplyDeps = {
    db,
    now: () => Math.floor(Date.now() / 1000),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    createProduct: (merged, content) => sc.createShopifyProduct(merged, content, { status: "draft", images: [], extraTags: [SOURCE_TAG], finalPrices: true }),
    // assets.costway.ca drops connections under a burst ("fetch failed", seen on ~40% of the first
    // batch's images): retry with a growing pause instead of leaving a hole in the gallery.
    downloadImage: async (url) => {
      let last = "";
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
        try {
          const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.costway.ca/" }, signal: AbortSignal.timeout(30_000) });
          if (!res.ok) { last = `download ${res.status}`; continue; }
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 2_000) { last = "image too small"; continue; }
          return buf.toString("base64");
        } catch (e) {
          last = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
        }
      }
      throw new Error(last || "download failed");
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
    attachVariantImages: (created, merged, sourceOf) => sc.attachVariantImages(created, merged, sourceOf),
    trackInventory: async (inventoryItemId, qty) => {
      await sc.enableVariantTracking(inventoryItemId);
      await sc.setInventoryLevel(inventoryItemId, await sc.getPrimaryLocationId(), qty);
    },
  };

  const t0 = Date.now();
  if (cmd === "repair") {
    // Re-upload the images a product is missing (a failed download leaves a hole), same neutral names.
    let added = 0, still = 0;
    for (const p of items) {
      if (Date.now() - t0 > maxMs) { console.log("⏱  time budget reached — re-run repair to continue"); break; }
      if (!APPLY) continue;
      const r = await imp.repairImages(p, deps);
      if (r.error === "not imported" || (r.ok && r.missingBefore === 0)) continue;
      added += r.added; still += r.stillMissing;
      console.log(`${r.ok ? (r.stillMissing ? "~" : "✓") : "✗"} ${p.itemNo} missing=${r.missingBefore} added=${r.added} still-missing=${r.stillMissing}${r.error ? " " + r.error : ""}${r.warnings.length ? "  ⚠ " + r.warnings.join(" | ") : ""}`);
    }
    console.log(`\n=== repair: images added=${added} still-missing=${still}${APPLY ? "" : "  (DRY — pass --apply)"} ===`);
    return;
  }

  let ok = 0, fail = 0, skipped = 0;
  const log = fs.createWriteStream(PLAN.replace(/\.json$/, "") + ".results.jsonl", { flags: "a" });
  for (const p of items) {
    if (Date.now() - t0 > maxMs) { console.log(`⏱  time budget reached — re-run apply to continue (imported items are skipped)`); break; }
    if (!APPLY) { console.log(`DRY ${p.itemNo} ${p.kind} ${p.variants.length}v ${p.imageUrls.length}img  ${p.content.titleFr}${p.problems.length ? "  ⚠ " + p.problems.join("; ") : ""}`); continue; }
    const r = await imp.applyPrepared(p, plan.batch, deps);
    if (!r.ok && r.error === "already imported") { skipped++; continue; }
    log.write(JSON.stringify({ ...r, at: new Date().toISOString() }) + "\n");
    if (r.ok) ok++; else fail++;
    console.log(`${r.ok ? "✓" : "✗"} ${p.itemNo} ${r.ok ? `${r.productId} ${r.handle} img=${r.imagesUploaded}` : r.error}${r.warnings.length ? "  ⚠ " + r.warnings.join(" | ") : ""}`);
  }
  log.end();
  console.log(`\n=== ok=${ok} fail=${fail} already-imported=${skipped} ===`);
}

// Costway imports are imports: charge them to the dedicated "import" pool, never the shared "batch" one (a
// 170-product prepare drained batch on 2026-10-17 and starved the social/blog jobs for the rest of the day).
import("@/lib/llm-budget")
  .then(({ withBudgetPool }) => withBudgetPool("import", main))
  .then(() => process.exit(0))
  .catch((e) => { console.error("FATAL:", e); process.exit(1); });
