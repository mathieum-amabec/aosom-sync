/**
 * backfill-fit-dims — write the `custom.lc_dims` metafield (per-SKU assembled + box sizes, cm) on every Shopify
 * product whose variant SKUs are in today's Aosom feed. It feeds the PDP "Est-ce que ça va entrer chez moi ?"
 * checker (theme snippet lc-fit). New imports get it at creation (shopify-client.ts); this fills the existing ones.
 *
 * Guardrails:
 *   - dry-run by default: prints counts + samples and writes .tmp-fit-dims-plan.csv for review;
 *   - only writes when the value changed (sorted JSON compare), so a re-run is a no-op;
 *   - products with no SKU in the feed (Costway, removed items) are left alone;
 *   - only the `custom.lc_dims` key is touched.
 *
 * USAGE (x64 Node, prod creds, through tsx):
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/backfill-fit-dims.mts               # dry-run
 *   …scripts/backfill-fit-dims.mts --apply [--limit=25]
 * Resumable: applied product ids go to .tmp-fit-dims-done.jsonl and are skipped next run.
 * RATE LIMIT: ~1.9 req/s; metafieldsSet batched 25 products per request.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import * as csvNs from "../src/lib/csv-fetcher";
import * as fitNs from "../src/lib/fit-dims";

// tsx compiles src/ to CJS here, so the named exports can arrive on `default` instead.
const unwrap = <T,>(ns: T): T => ((ns as unknown as { default?: T }).default ?? ns);
const { fetchAosomCatalog } = unwrap(csvNs);
const { buildFitDims, checkAgainstPage, serializeFitDims, FIT_DIMS_KEY, FIT_DIMS_NAMESPACE } = unwrap(fitNs);

const STORE = "27u5y2-kp.myshopify.com";
const API = "2025-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
const APPLY = process.argv.includes("--apply");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const CHECKPOINT = ".tmp-fit-dims-done.jsonl";
const PLAN = ".tmp-fit-dims-plan.csv";

let lastReq = 0;
interface GqlEnvelope<T> {
  data?: T;
  errors?: { message: string }[];
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number } } };
}
async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<GqlEnvelope<T>> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = 520 - (Date.now() - lastReq);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastReq = Date.now();
    const res = await fetch(`https://${STORE}/admin/api/${API}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const j = (await res.json()) as GqlEnvelope<T>;
    if (res.status === 429 || j.errors?.some((e) => /throttl/i.test(e.message))) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    const avail = j.extensions?.cost?.throttleStatus?.currentlyAvailable;
    if (avail !== undefined && avail < 300) await new Promise((r) => setTimeout(r, 2000));
    return j;
  }
  throw new Error("GraphQL throttled 6 times in a row");
}

interface ProductNode {
  id: string;
  handle: string;
  status: string;
  description: string;
  variants: { nodes: { sku: string | null }[] };
  metafield: { value: string } | null;
}

async function main() {
  if (!TOKEN) throw new Error("SHOPIFY_ACCESS_TOKEN missing");
  const feed = await fetchAosomCatalog();
  const bySku = new Map(feed.map((p) => [p.sku, p]));
  console.log(`feed: ${feed.length} SKUs`);

  const products: ProductNode[] = [];
  let cursor: string | null = null;
  do {
    const r: GqlEnvelope<{ products: { nodes: ProductNode[]; pageInfo: { hasNextPage: boolean; endCursor: string } } }> = await gql(
      `query($after: String) { products(first: 100, after: $after) {
        nodes { id handle status description variants(first: 100) { nodes { sku } } metafield(namespace: "${FIT_DIMS_NAMESPACE}", key: "${FIT_DIMS_KEY}") { value } }
        pageInfo { hasNextPage endCursor } } }`,
      { after: cursor },
    );
    if (!r.data) throw new Error(JSON.stringify(r.errors));
    products.push(...r.data.products.nodes);
    cursor = r.data.products.pageInfo.hasNextPage ? r.data.products.pageInfo.endCursor : null;
  } while (cursor);
  console.log(`shopify: ${products.length} products`);

  const done = new Set<string>(existsSync(CHECKPOINT) ? readFileSync(CHECKPOINT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);
  const plan: { id: string; handle: string; status: string; value: string; skus: number; matched: number }[] = [];
  let noFeed = 0, noDims = 0, unchanged = 0, partial = 0, conflict = 0;
  const conflicts: string[] = [];
  for (const p of products) {
    const skus = p.variants.nodes.map((v) => (v.sku || "").trim()).filter(Boolean);
    const rows = skus.flatMap((sku) => {
      const f = bySku.get(sku);
      return f?.dimensionsRaw ? [{ sku, ...f.dimensionsRaw, boxSize: f.boxSize }] : [];
    });
    if (rows.length === 0) { noFeed++; continue; }
    const built = buildFitDims(rows);
    if (!built) { noDims++; continue; }
    // The page states another size: one of the two is wrong, so show no checker rather than a contradiction.
    const dims = checkAgainstPage(built, p.description);
    if (!dims) { conflict++; conflicts.push(p.handle); continue; }
    const value = serializeFitDims(dims);
    if (p.metafield?.value === value) { unchanged++; continue; }
    const matched = Object.keys(dims.s).length;
    if (matched < skus.length) partial++;
    plan.push({ id: p.id, handle: p.handle, status: p.status, value, skus: skus.length, matched });
  }
  writeFileSync(PLAN, "id,handle,status,skus,with_dims,value\n" + plan.map((x) => [x.id, x.handle, x.status, x.skus, x.matched, `"${x.value.replace(/"/g, '""')}"`].join(",")).join("\n"));
  console.log({ toWrite: plan.length, unchanged, noFeedMatch: noFeed, feedButNoSize: noDims, pageSizeConflict: conflict, someVariantsWithoutSize: partial, active: plan.filter((x) => x.status === "ACTIVE").length });
  writeFileSync(".tmp-fit-dims-conflicts.txt", conflicts.join("\n"));
  for (const x of plan.filter((_, i) => i % Math.max(1, Math.floor(plan.length / 5)) === 0).slice(0, 5)) console.log(" ", x.handle, x.value.slice(0, 160));
  console.log(`plan written to ${PLAN}`);
  if (!APPLY) return console.log("DRY-RUN — nothing written. Re-run with --apply.");

  const todo = plan.filter((x) => !done.has(x.id)).slice(0, LIMIT);
  let ok = 0, failed = 0;
  for (let i = 0; i < todo.length; i += 25) {
    const batch = todo.slice(i, i + 25);
    const r = await gql<{ metafieldsSet: { userErrors: { field: string[]; message: string }[] } }>(
      `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`,
      { m: batch.map((x) => ({ ownerId: x.id, namespace: FIT_DIMS_NAMESPACE, key: FIT_DIMS_KEY, type: "json", value: x.value })) },
    );
    const errs = r.data?.metafieldsSet.userErrors ?? [{ field: [], message: JSON.stringify(r.errors) }];
    if (errs.length) { failed += batch.length; console.error("batch failed:", JSON.stringify(errs).slice(0, 300)); continue; }
    for (const x of batch) appendFileSync(CHECKPOINT, JSON.stringify({ id: x.id }) + "\n");
    ok += batch.length;
    console.log(`written ${ok}/${todo.length}`);
  }
  console.log({ written: ok, failed });
}

main().catch((e) => { console.error(e); process.exit(1); });
