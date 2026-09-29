/**
 * register-en-product-translations — register the EN Shopify translations of every live
 * product from the English copy the import pipeline already wrote to metafields
 * (custom.title_en / body_html_en / meta_title_en / meta_description_en).
 *
 * Why: the theme renders those metafields for EN shoppers (Furnish Direct), but Shopify itself
 * had NO EN translation for ~97 % of products (audit 2026-09-28: 1421 / 1466 live), so the EN
 * page <title>, and anything reading Shopify translations (Google, feeds), got the FRENCH text.
 *
 * Guardrails:
 *   - never overwrites an existing EN translation (only fills missing keys);
 *   - skips a value that contains a forbidden supplier name (Aosom & co. — client-facing);
 *   - skips an "EN" value that actually reads as French (stop-word heuristic);
 *   - skips a value that quotes a dollar price (frozen at import → often stale);
 *   - handle is NOT translated (would change EN URLs).
 *
 * USAGE (x64 Node, prod creds, through tsx):
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/register-en-product-translations.mts            # dry-run
 *   …scripts/register-en-product-translations.mts --apply [--limit=10] [--ids=123,456]
 * Resumable: every applied product id is appended to --checkpoint (default
 * .tmp-en-translations-done.jsonl) and skipped on the next run.
 *
 * RATE LIMIT: requests serialized ~1.9 req/s; mutations batched 10 products per request.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { EN_FIELD_MAP, rejectEnValue } from "../src/lib/en-translations";

const STORE = "27u5y2-kp.myshopify.com";
const API = "2025-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
const APPLY = process.argv.includes("--apply");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const ONLY_IDS = arg("ids") ? new Set(arg("ids")!.split(",").map((s) => `gid://shopify/Product/${s}`)) : null;
const CHECKPOINT = arg("checkpoint") ?? ".tmp-en-translations-done.jsonl";

const FIELD_MAP: Record<string, string> = EN_FIELD_MAP;

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
  title: string;
  status: string;
  publishedAt: string | null;
  translations: { key: string }[];
  metafields: { nodes: { key: string; value: string }[] };
}

async function main() {
  if (!TOKEN) throw new Error("SHOPIFY_ACCESS_TOKEN missing");
  const done = new Set<string>(
    existsSync(CHECKPOINT) ? readFileSync(CHECKPOINT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : [],
  );

  // 1. Live products + their EN metafields + which EN translations already exist.
  const products: ProductNode[] = [];
  let cursor: string | null = null;
  do {
    const r: GqlEnvelope<{ products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: ProductNode[] } }> = await gql(
      `query($c:String){products(first:100,after:$c,query:"status:active"){pageInfo{hasNextPage endCursor}
        nodes{id title status publishedAt translations(locale:"en"){key}
        metafields(first:10,namespace:"custom"){nodes{key value}}}}}`,
      { c: cursor },
    );
    if (!r.data) throw new Error(`products query failed: ${JSON.stringify(r.errors)}`);
    products.push(...r.data.products.nodes);
    cursor = r.data.products.pageInfo.hasNextPage ? r.data.products.pageInfo.endCursor : null;
  } while (cursor);

  // 2. Build the plan.
  interface Planned { id: string; title: string; fields: { key: string; value: string }[] }
  const plan: Planned[] = [];
  const skipped: { id: string; title: string; key: string; reason: string }[] = [];
  for (const p of products) {
    if (!p.publishedAt) continue;
    if (ONLY_IDS && !ONLY_IDS.has(p.id)) continue;
    if (done.has(p.id)) continue;
    const existing = new Set(p.translations.map((t) => t.key));
    const mf = Object.fromEntries(p.metafields.nodes.map((m) => [m.key, m.value]));
    const fields: Planned["fields"] = [];
    for (const [key, mfKey] of Object.entries(FIELD_MAP)) {
      const value = (mf[mfKey] ?? "").trim();
      if (existing.has(key) || !value) continue;
      const reject = rejectEnValue(value);
      if (reject) { skipped.push({ id: p.id, title: p.title, key, reason: reject }); continue; }
      fields.push({ key, value });
    }
    if (fields.length) plan.push({ id: p.id, title: p.title, fields });
  }
  const todo = plan.slice(0, LIMIT);
  const byKey = (k: string) => todo.filter((p) => p.fields.some((f) => f.key === k)).length;
  console.log(`${APPLY ? "APPLY" : "DRY-RUN"} — produits actifs lus: ${products.length} | à traiter: ${todo.length}/${plan.length} (déjà faits: ${done.size})`);
  console.log(`  title=${byKey("title")} body_html=${byKey("body_html")} meta_title=${byKey("meta_title")} meta_description=${byKey("meta_description")}`);
  console.log(`  champs sautés: ${skipped.length}`);
  for (const s of skipped.slice(0, 30)) console.log(`   - ${s.id.split("/").pop()} ${s.key}: ${s.reason} | ${s.title}`);

  if (!APPLY) {
    for (const p of todo.slice(0, 3)) {
      console.log(`\n  ${p.id.split("/").pop()} | FR: ${p.title}`);
      for (const f of p.fields) console.log(`    ${f.key} → ${f.value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 110)}`);
    }
    return;
  }

  // 3. Apply in chunks: fetch digests for 10 products, then one aliased mutation.
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < todo.length; i += 10) {
    const chunk = todo.slice(i, i + 10);
    const d: GqlEnvelope<{ translatableResourcesByIds: { nodes: { resourceId: string; translatableContent: { key: string; digest: string }[] }[] } }> = await gql(
      `query($ids:[ID!]!){translatableResourcesByIds(first:10,resourceIds:$ids){nodes{resourceId translatableContent{key digest}}}}`,
      { ids: chunk.map((p) => p.id) },
    );
    const digests = new Map(
      (d.data?.translatableResourcesByIds.nodes ?? []).map((n) => [n.resourceId, Object.fromEntries(n.translatableContent.map((c) => [c.key, c.digest]))]),
    );
    const vars: Record<string, unknown> = {};
    const parts: string[] = [];
    const sent: Planned[] = [];
    chunk.forEach((p, n) => {
      const dg = digests.get(p.id);
      const tr = p.fields
        .filter((f) => dg?.[f.key])
        .map((f) => ({ key: f.key, value: f.value, locale: "en", translatableContentDigest: dg![f.key] }));
      if (!tr.length) return;
      vars[`id${n}`] = p.id;
      vars[`t${n}`] = tr;
      parts.push(`m${n}: translationsRegister(resourceId:$id${n}, translations:$t${n}){ userErrors{field message} }`);
      sent.push(p);
    });
    if (!parts.length) continue;
    const decl = Object.keys(vars).map((k) => `$${k}:${k.startsWith("id") ? "ID!" : "[TranslationInput!]!"}`).join(",");
    const r: GqlEnvelope<Record<string, { userErrors: { message: string }[] }>> = await gql(`mutation(${decl}){${parts.join("\n")}}`, vars);
    chunk.forEach((p, n) => {
      if (!sent.includes(p)) return;
      const res = r.data?.[`m${n}`];
      if (res && res.userErrors.length === 0) {
        ok++;
        appendFileSync(CHECKPOINT, JSON.stringify({ id: p.id, keys: p.fields.map((f) => f.key) }) + "\n");
      } else {
        failed++;
        console.error(`  ÉCHEC ${p.id.split("/").pop()} ${p.title}: ${JSON.stringify(res?.userErrors ?? r.errors)}`);
      }
    });
    if ((i / 10) % 10 === 0) console.log(`  … ${Math.min(i + 10, todo.length)}/${todo.length} (ok=${ok} échecs=${failed})`);
  }
  console.log(`\nTERMINÉ — ok=${ok} échecs=${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
