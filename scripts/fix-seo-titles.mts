/**
 * fix-seo-titles — repair the Shopify SEO titles (global.title_tag) that were cut mid-phrase.
 *
 * Why: until v0.5.107.36 the meta title was "<name> | Livraison gratuite — Ameublo Direct". The
 * 37-char suffix left ~28 chars of the 65-char budget for the name, and the word-boundary cut
 * produced "Tables de chevet avec | …", "Bureau d'ordinateur 3 | …" (350 / 2,269 active products
 * on 2026-10-16). New titles are "<name> | Ameublo Direct", built by buildMetaTitle().
 *
 * A product is rewritten when its SEO title's name part (before " | "):
 *   - ends on a stopword / connector ("avec", "de", "pour", "et", "with", …)        → dangling
 *   - ends on a bare number or separator AND is not the whole product title      → dangling
 *   - is shorter than 12 chars                                                   → short
 *   - is the exact SEO title of another active product                           → duplicate
 *   - (opt-in, --include-old-suffix) still carries the old "| Livraison gratuite — …" suffix → old-suffix
 * The new title is always rebuilt from product.title (the full FR title).
 * Products with no SEO title (Shopify falls back to the product title) are left alone.
 *
 * USAGE (x64 Node, prod creds, through tsx):
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/fix-seo-titles.mts            # dry run
 *   …scripts/fix-seo-titles.mts --apply [--limit=10] [--include-old-suffix]
 * Dry run writes before → after to .context/seo-titles-dryrun.json. --apply updates through
 * productUpdate(input:{id, seo:{title}}) at < 2 req/s and appends every applied id to
 * .context/seo-titles-applied.jsonl; a rerun skips ids already there (resumable).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const mtMod = (await import("../src/lib/meta-title")) as typeof import("../src/lib/meta-title");
const { buildMetaTitle, endsOnStopword, endsOnDanglingToken } =
  (mtMod as { default?: typeof mtMod }).default ?? mtMod;

const STORE = "27u5y2-kp.myshopify.com";
const API = "2025-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
const APPLY = process.argv.includes("--apply");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const INCLUDE_OLD_SUFFIX = process.argv.includes("--include-old-suffix");
const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const OUT_DIR = ".context";
const DRYRUN_FILE = `${OUT_DIR}/seo-titles-dryrun.json`;
const CHECKPOINT = `${OUT_DIR}/seo-titles-applied.jsonl`;
const MIN_NAME = 12;

let lastReq = 0;
interface GqlEnvelope<T> {
  data?: T;
  errors?: { message: string }[];
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number } } };
}
async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<GqlEnvelope<T>> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = 520 - (Date.now() - lastReq); // < 2 req/s
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
  title: string;
  handle: string;
  seo: { title: string | null };
}
interface Change {
  id: string;
  handle: string;
  title: string;
  reasons: string[];
  before: string;
  after: string;
}

async function listActiveProducts(): Promise<ProductNode[]> {
  const all: ProductNode[] = [];
  let after: string | null = null;
  for (;;) {
    const r: GqlEnvelope<{
      products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: ProductNode[] };
    }> = await gql(
      `query($after: String) {
        products(first: 250, after: $after, query: "status:active") {
          pageInfo { hasNextPage endCursor }
          nodes { id title handle seo { title } }
        }
      }`,
      { after },
    );
    if (r.errors?.length || !r.data) throw new Error(`products query failed: ${JSON.stringify(r.errors)}`);
    all.push(...r.data.products.nodes);
    if (!r.data.products.pageInfo.hasNextPage) break;
    after = r.data.products.pageInfo.endCursor;
  }
  return all;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

async function main() {
  if (!TOKEN) throw new Error("SHOPIFY_ACCESS_TOKEN missing (run with --env-file=.env.local)");
  const products = await listActiveProducts();
  console.log(`active products: ${products.length}`);

  const seoCount = new Map<string, number>();
  for (const p of products) {
    const t = p.seo.title ? norm(p.seo.title).toLowerCase() : "";
    if (t) seoCount.set(t, (seoCount.get(t) ?? 0) + 1);
  }

  const stats = { noSeoTitle: 0, oldSuffix: 0, dangling: 0, short: 0, duplicate: 0, "old-suffix": 0, unchanged: 0 };
  const changes: Change[] = [];
  for (const p of products) {
    if (!p.seo.title) { stats.noSeoTitle++; continue; }
    const before = norm(p.seo.title);
    if (before.includes("Livraison gratuite — Ameublo Direct")) stats.oldSuffix++;
    const namePart = before.split(" | ")[0].trim();
    const fullTitle = norm(p.title);
    const reasons: string[] = [];
    if (endsOnStopword(namePart) || (endsOnDanglingToken(namePart) && namePart !== fullTitle)) reasons.push("dangling");
    if (namePart.length < MIN_NAME) reasons.push("short");
    if ((seoCount.get(before.toLowerCase()) ?? 0) > 1) reasons.push("duplicate");
    if (!reasons.length && INCLUDE_OLD_SUFFIX && before.includes(" | Livraison gratuite — ")) reasons.push("old-suffix");
    if (!reasons.length) continue;
    const after = buildMetaTitle(fullTitle, "fr");
    if (after === before) { stats.unchanged++; continue; }
    for (const r of reasons) stats[r as "dangling" | "short" | "duplicate" | "old-suffix"]++;
    changes.push({ id: p.id, handle: p.handle, title: fullTitle, reasons, before, after });
  }

  // Duplicates that survive the rewrite (two products with the same FR title).
  const afterCount = new Map<string, number>();
  const finalTitle = new Map(products.map((p) => [p.id, p.seo.title ? norm(p.seo.title) : ""]));
  for (const c of changes) finalTitle.set(c.id, c.after);
  for (const t of finalTitle.values()) if (t) afterCount.set(t.toLowerCase(), (afterCount.get(t.toLowerCase()) ?? 0) + 1);
  const stillDuplicate = [...afterCount.values()].filter((n) => n > 1).reduce((a, n) => a + n, 0);

  console.log(`to rewrite: ${changes.length}`, stats, `products still sharing an SEO title after rewrite: ${stillDuplicate}`);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    DRYRUN_FILE,
    JSON.stringify({ generatedAt: new Date().toISOString(), activeProducts: products.length, stats, stillDuplicate, changes }, null, 2),
  );
  console.log(`before → after written to ${DRYRUN_FILE}`);
  for (const c of changes.slice(0, 15)) console.log(`  [${c.reasons.join(",")}] ${c.before}  →  ${c.after}`);

  if (!APPLY) { console.log("DRY RUN — nothing written. Re-run with --apply to update Shopify."); return; }

  const done = new Set<string>(
    existsSync(CHECKPOINT)
      ? readFileSync(CHECKPOINT, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id)
      : [],
  );
  let applied = 0;
  let failed = 0;
  for (const c of changes) {
    if (applied >= LIMIT) break;
    if (done.has(c.id)) continue;
    const r = await gql<{ productUpdate: { userErrors: { field: string[]; message: string }[] } }>(
      `mutation($input: ProductInput!) { productUpdate(input: $input) { userErrors { field message } } }`,
      { input: { id: c.id, seo: { title: c.after } } },
    );
    const errs = [...(r.errors ?? []), ...(r.data?.productUpdate.userErrors ?? [])];
    if (errs.length || !r.data) {
      failed++;
      console.error(`FAIL ${c.handle}: ${JSON.stringify(errs)}`);
      continue;
    }
    appendFileSync(CHECKPOINT, JSON.stringify({ id: c.id, before: c.before, after: c.after, at: new Date().toISOString() }) + "\n");
    applied++;
    if (applied % 25 === 0) console.log(`applied ${applied}/${changes.length}`);
  }
  console.log(`done: applied ${applied}, failed ${failed}, already in checkpoint ${done.size}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
