// Lifestyle backfill — STEP 1: extended DRY-RUN over ALL active Shopify products.
//
// Reads every active product's media from Shopify Admin GraphQL (paginated, ~2 req/s),
// classifies ALL its images with the validated classifyProductImages() (download ≤5s/≤2MB
// → sharp border-10% white ratio), and reports whether the featured image (media pos 0)
// would change to a lifestyle shot. READ-ONLY — no product writes.
//
// Run:  node node_modules/tsx/dist/cli.mjs scripts/lifestyle-backfill-all-dry-run.mts
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gql, sleep } from "./_shopify-lib.mjs";
import { classifyProductImages } from "../src/lib/variant-merger";

const __dirname = dirname(fileURLToPath(import.meta.url));

const Q = `query($cursor: String){
  products(first: 25, after: $cursor, query: "status:active"){
    pageInfo{ hasNextPage endCursor }
    nodes{
      legacyResourceId
      handle
      media(first: 20){ nodes{ mediaContentType ... on MediaImage { image { url } } } }
    }
  }
}`;

// ── 1. Page through all active products (collect media URLs in order) ─────────
console.log("Fetching active products from Shopify (read-only, ~2 req/s)…");
type Prod = { id: string; handle: string; images: string[] };
const products: Prod[] = [];
let cursor: string | null = null;
let pages = 0;
while (true) {
  const { data }: any = await gql(Q, { cursor });
  pages++;
  for (const n of data.products.nodes) {
    const images = (n.media?.nodes ?? [])
      .filter((m: any) => m.mediaContentType === "IMAGE" && m.image?.url)
      .map((m: any) => m.image.url as string);
    products.push({ id: String(n.legacyResourceId), handle: String(n.handle ?? ""), images });
  }
  if (!data.products.pageInfo.hasNextPage) break;
  cursor = data.products.pageInfo.endCursor;
  await sleep(550);
}
console.log(`Got ${products.length} active products across ${pages} page(s).\n`);

// ── 2. Classify images per product (concurrency pool; CDN downloads) ──────────
interface Row {
  product_id: string; handle: string; current0: string; proposed0: string;
  changed: boolean; noLifestyle: boolean; noImages: boolean;
}
const rows: Row[] = new Array(products.length);
let done = 0;

async function analyse(p: Prod, idx: number): Promise<void> {
  if (p.images.length === 0) {
    rows[idx] = { product_id: p.id, handle: p.handle, current0: "", proposed0: "", changed: false, noLifestyle: false, noImages: true };
  } else {
    const current0 = p.images[0];
    const kinds = await classifyProductImages(p.images);
    const firstLifestyle = kinds.find((k) => k.kind === "lifestyle_url" || k.kind === "lifestyle_bg");
    const noLifestyle = !firstLifestyle;
    const proposed0 = firstLifestyle ? firstLifestyle.url : current0;
    rows[idx] = { product_id: p.id, handle: p.handle, current0, proposed0, changed: proposed0 !== current0, noLifestyle, noImages: false };
  }
  done++;
  if (done % 50 === 0) console.log(`  …${done}/${products.length} analysed`);
}

const CONCURRENCY = 6;
let next = 0;
async function worker() {
  while (next < products.length) {
    const idx = next++;
    await analyse(products[idx], idx);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, products.length) }, worker));

// ── 3. CSV + summary ─────────────────────────────────────────────────────────
const headers = ["product_id", "handle", "image_actuelle_url", "image_proposee_url", "changement"];
const esc = (v: string) => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
const lines = [headers.join(",")];
for (const r of rows) {
  lines.push([r.product_id, r.handle, r.current0, r.proposed0, r.changed ? "oui" : "non"].map((v) => esc(String(v))).join(","));
}
mkdirSync(join(__dirname, "..", "docs"), { recursive: true });
writeFileSync(join(__dirname, "..", "docs", "lifestyle-backfill-all-dry-run.csv"), "﻿" + lines.join("\r\n") + "\r\n", "utf8");

const changed = rows.filter((r) => r.changed).length;
const noLifestyle = rows.filter((r) => r.noLifestyle).length;
const noImages = rows.filter((r) => r.noImages).length;
console.log("\n" + "─".repeat(70));
console.log(`Total produits actifs analysés : ${rows.length}`);
console.log(`Changeraient d'image vedette   : ${changed}`);
console.log(`Sans image lifestyle (fond blanc seulement) : ${noLifestyle}`);
console.log(`Sans aucune image              : ${noImages}`);
console.log(`Déjà correct (lifestyle déjà en pos 0) : ${rows.length - changed - noLifestyle - noImages}`);
console.log(`CSV : docs/lifestyle-backfill-all-dry-run.csv`);
console.log("\nDRY-RUN — aucune écriture Shopify. STOP — en attente de validation de Mat.");
process.exit(0);
