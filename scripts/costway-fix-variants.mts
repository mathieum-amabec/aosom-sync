#!/usr/bin/env tsx
/**
 * scripts/costway-fix-variants.mts — repair Costway products already on Shopify whose size variants were imported
 * under colour labels ("Vert", "Vert 2", "Titre par défaut 2"; 47 products on 2026-10-17), and titles that name one
 * size of a multi-size product or a "Lot de N" the supplier never sold. Same rules as the importer
 * (costway/variant-size.ts), so the fixed products match new imports.
 *
 *   node-x64 --env-file=<main clone>/.env.local node_modules/tsx/dist/cli.mjs scripts/costway-fix-variants.mts           # dry run
 *   node-x64 --env-file=… node_modules/tsx/dist/cli.mjs scripts/costway-fix-variants.mts --apply                          # writes
 *   [--only <shopifyId,…>] [--status active|draft (also set the product status)]
 *
 * Writes per product: option names/values, variant order (smallest first), title, the FR/EN SEO titles and EN title
 * metafields, and the EN translations of the new option values. Prices, SKUs, photos and stock are not touched.
 * Idempotent: a product already in the target shape is reported "ok" and skipped.
 */
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] ?? null : null; };
const only = flag("--only")?.split(",").map((s) => s.trim());
const setStatus = flag("--status");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sizes the titles alone cannot give (checked by hand 2026-10-17): internal SKU → English size wording. */
const SIZE_OVERRIDES: Record<string, string> = {
  // "8 FT …-XL", "6 FT …-M", "6/7/8 FT …-L"
  M4FXPMQM: "8 ft (244 cm)", MENT5QXF: "6 ft (183 cm)", MENZ9J5K: "7 ft (213 cm)",
};
/** Titles rewritten by hand (no size variants, but the generated title was wrong). */
const TITLE_OVERRIDES: Record<string, { fr: string; en: string }> = {
  "15412420182121": { fr: "Lit superposé cabane simple sur double en bois", en: "Twin over Full Wooden House Bunk Bed" },
  "15412421132393": { fr: "Table basse relevable extensible 3-en-1 avec 4 tabourets", en: "3-in-1 Expandable Lift-Top Coffee Table with 4 Stools" },
};

interface Variant { id: number; sku: string; option1: string | null; option2: string | null; position: number }
interface Product { id: number; title: string; status: string; options: Array<{ name: string; values: string[] }>; variants: Variant[] }

async function main() {
  const { ensureSchema } = await import("@/lib/database");
  const sc = await import("@/lib/shopify-client");
  const { toFrenchSize } = await import("@/lib/size-names");
  const { translateColor } = await import("@/lib/variant-merger");
  const vs = await import("@/lib/costway/variant-size");
  const db = await ensureSchema();

  const rows = (
    await db.execute(`SELECT shopify_product_id AS id, internal_sku, sku, title, color, body_html FROM costway_products
                      WHERE shopify_product_id IS NOT NULL AND shopify_product_id != ''`)
  ).rows as unknown as Array<{ id: string; internal_sku: string; sku: string; title: string; color: string | null; body_html: string | null }>;
  const byProduct = new Map<string, typeof rows>();
  for (const r of rows) byProduct.set(String(r.id), [...(byProduct.get(String(r.id)) ?? []), r]);
  const ids = [...byProduct.keys()].filter((id) => (only ? only.includes(id) : byProduct.get(id)!.length > 1 || TITLE_OVERRIDES[id]));
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${ids.length} Costway product(s) to check`);

  const get = async (path: string) => {
    for (let a = 0; a < 5; a++) {
      const res = await sc.shopifyFetch(path);
      await sleep(550);
      if (res.status === 429) { await sleep(2000); continue; }
      if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
      return res.json();
    }
    throw new Error(`GET ${path} → 429`);
  };
  const put = async (path: string, body: unknown) => {
    for (let a = 0; a < 5; a++) {
      const res = await sc.shopifyFetch(path, { method: "PUT", body: JSON.stringify(body) });
      await sleep(550);
      if (res.status === 429) { await sleep(2000); continue; }
      if (!res.ok) throw new Error(`PUT ${path} → ${res.status} ${await res.text()}`);
      return res.json();
    }
    throw new Error(`PUT ${path} → 429`);
  };

  const tally = { fixed: 0, ok: 0, needsHuman: 0, errors: 0 };
  for (const id of ids) {
    try {
      const src = byProduct.get(id)!;
      const p = (await get(`/products/${id}.json?fields=id,title,status,options,variants`)).product as Product;
      const rowOf = (v: Variant) => src.find((r) => r.internal_sku === v.sku);
      if (p.variants.some((v) => !rowOf(v))) { console.log(`⚠ ${id}: a variant has no source row — needs a human`); tally.needsHuman++; continue; }

      const variants = [...p.variants].sort((a, b) => a.position - b.position);
      const found = vs.variantSizes(variants.map((v) => ({ title: rowOf(v)!.title, sku: rowOf(v)!.sku, color: rowOf(v)!.color ?? "" })));
      const sizes = found?.map((s, i) => SIZE_OVERRIDES[variants[i].sku] ?? s);
      if (!sizes) { console.log(`⚠ ${id} ${p.title}: no size tells the variants apart — needs a human`); tally.needsHuman++; continue; }
      const sized = sizes.some(Boolean);

      // Target shape.
      const colours = variants.map((v) => { const c = translateColor(rowOf(v)!.color ?? ""); return /^multicolou?r$/i.test(c) ? "Multicolore" : c; });
      const sizeOnly = sized && new Set(colours.map((c) => c.toLowerCase())).size === 1;
      const sizeEn = new Map<string, string>();
      const fr = (raw: string) => { const f = toFrenchSize(raw); if (f !== raw) sizeEn.set(f, raw); return f; };
      const order = variants.map((_, i) => i);
      if (sized) order.sort((a, b) => vs.sizeRank(sizes[a]) - vs.sizeRank(sizes[b]));
      const target = order.map((i, pos) => ({
        id: variants[i].id,
        position: pos + 1,
        option1: sized ? (sizeOnly ? fr(sizes[i]) : colours[i]) : variants[i].option1,
        option2: sized && !sizeOnly ? fr(sizes[i]) : sized ? null : variants[i].option2,
      }));
      const options = sized ? (sizeOnly ? [{ name: "Taille" }] : [{ name: "Couleur" }, { name: "Taille" }]) : null;

      const supplierTexts = src.flatMap((r) => [r.title, r.body_html ?? ""]);
      const strip = (t: string) => vs.stripVariantSize(t, { sizes: sizes, supplierTexts });
      const manual = TITLE_OVERRIDES[id];
      // Without size variants only the hand-checked titles change ("Lot de 2" on snowshoes is a pair, not an error).
      const title = manual?.fr ?? (sized ? strip(p.title) : p.title);

      const optionsSame = !options || (options.length === p.options.length && options.every((o, i) => o.name === p.options[i].name));
      const variantsSame = target.every((t) => {
        const v = p.variants.find((x) => x.id === t.id)!;
        return v.position === t.position && v.option1 === t.option1 && (v.option2 ?? null) === (t.option2 ?? null);
      });
      const statusSame = !setStatus || p.status === setStatus;
      if (optionsSame && variantsSame && title === p.title && statusSame) { tally.ok++; continue; }

      console.log(`\n${id}  "${p.title}"${title !== p.title ? `\n   → "${title}"` : ""}`);
      if (!optionsSame || !variantsSame) {
        const before = variants.map((v) => [v.option1, v.option2].filter(Boolean).join(" / ") + ` ${(p.variants.find((x) => x.id === v.id) as unknown as { price?: string }).price ?? ""}`);
        console.log(`   avant: ${before.join(" | ")}`);
        const priceOf = (vid: number) => (p.variants.find((x) => x.id === vid) as unknown as { price: string }).price;
        console.log(`   après (${(options ?? p.options).map((o) => o.name).join("/")}): ${target.map((t) => [t.option1, t.option2].filter(Boolean).join(" / ") + ` ${priceOf(t.id)}`).join(" | ")}`);
      }
      tally.fixed++;
      if (!APPLY) continue;

      await put(`/products/${id}.json`, {
        product: {
          id: Number(id),
          title,
          ...(setStatus ? { status: setStatus } : {}),
          ...(options ? { options } : {}),
          variants: target.map((t) => ({ id: t.id, position: t.position, option1: t.option1, ...(options ? { option2: t.option2 } : {}) })),
        },
      });

      // SEO titles (FR/EN) and the EN title metafield name one size too.
      if (title !== p.title) {
        const mfs = (await get(`/products/${id}/metafields.json`)).metafields as Array<{ id: number; namespace: string; key: string; value: string }>;
        for (const m of mfs) {
          const k = `${m.namespace}.${m.key}`;
          if (!["global.title_tag", "custom.title_en", "custom.meta_title_en"].includes(k)) continue;
          const next = manual
            ? k === "custom.title_en" ? manual.en : k === "global.title_tag" ? `${manual.fr} | Ameublo Direct` : `${manual.en} | Furnish Direct`
            : strip(m.value);
          if (next !== m.value) await put(`/metafields/${m.id}.json`, { metafield: { id: m.id, value: next } });
          if (k === "custom.title_en" && next !== m.value) await sc.registerProductEnTranslations(id, { title: next }).catch(() => []);
        }
      }
      if (sizeEn.size) await sc.registerOptionEnTranslations(id, sizeEn);
    } catch (e) {
      console.log(`✗ ${id}: ${e instanceof Error ? e.message : e}`);
      tally.errors++;
    }
  }
  console.log(`\n${JSON.stringify(tally)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
