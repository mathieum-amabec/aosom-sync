/**
 * PILOT IMPORT — top-5 best-sellers per thin collection, full pipeline (Claude FR/EN →
 * Shopify create+publish → Turso link + collection assignment), via the REAL production
 * pipeline functions (queueForImport / generateContent / importToShopify).
 *
 * - Correct variant grouping: uses the live Aosom CSV + mergeVariants (PSIN), so each
 *   imported product carries ALL its colour/size variants — not a single orphan SKU.
 * - Per-group checkpoint (scripts/pilot-import.checkpoint.jsonl): resume-safe. A group that
 *   is done / errored / skipped is never re-attempted (no duplicate Shopify products).
 * - Time-budgeted for foreground windows: exits after MAX_SECONDS; re-run to continue.
 * - Rate-limited: paced between products (Shopify 2 req/sec target; shopifyFetch also 429-retries).
 *
 *   node-x64 (tsx) scripts/pilot-import.mts --plan     # selection only, no writes
 *   node-x64 (tsx) scripts/pilot-import.mts [maxSeconds]
 */
import { readFileSync, appendFileSync, existsSync } from "node:fs";

// ── env (before importing libs that read process.env) ──
{
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const l of raw.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const PLAN = process.argv.includes("--plan");
const MAX_SECONDS = Number(process.argv.find((a) => /^\d+$/.test(a)) || 540);
const PER_COLL = 5;
const MIN_STOCK = 10;
const PACE_MS = 1500; // between products
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN!;
const started = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => String(s).replace(/ /g, " ").toLowerCase();

// Priority order given by the operator (0-3 live collections first).
const TARGETS = [
  "electro-chauffage", "salon-fauteuils-releveurs", "animaux-oiseaux", "sport-salle-de-jeux",
  "sante-et-beaute", "rangement-bibliotheques", "chambre-bases-de-lit", "salon-canapes-simples",
  "cuisine-ensembles-bar", "salon-sectionnels", "salon-tables-appoint", "cuisine-tables-bar",
  "sdb-armoires-sur-pied", "chambre-matelas", "rangement-penderies", "animaux-petits",
  "rangement-poufs-bancs", "sdb-armoires-pharmacie",
];

const CKPT = new URL("../pilot-import.checkpoint.jsonl", import.meta.url);
const done = new Set<string>();                    // every checkpointed groupKey (never re-attempt)
const doneSuccessByColl = new Map<string, number>(); // status==='done' count per collection (counts toward the 5-cap)
if (existsSync(CKPT)) {
  for (const l of readFileSync(CKPT, "utf8").split(/\r?\n/)) {
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l);
      if (o.groupKey) done.add(String(o.groupKey));
      if (o.status === "done" && o.collection) doneSuccessByColl.set(o.collection, (doneSuccessByColl.get(o.collection) || 0) + 1);
    } catch { /* skip */ }
  }
  process.stderr.write(`resume: ${done.size} groups in checkpoint; successes/coll: ${JSON.stringify(Object.fromEntries(doneSuccessByColl))}\n`);
}
function ckpt(rec: Record<string, unknown>) { appendFileSync(CKPT, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n"); }

// ── Shopify GET (rules for the 18 collections) ──
let lastShop = 0;
async function shopGet(path: string): Promise<Response> {
  const w = 550 - (Date.now() - lastShop); if (w > 0) await sleep(w); lastShop = Date.now();
  const r = await fetch(`https://${STORE}/admin/api/${API}${path}`, { headers: { "X-Shopify-Access-Token": TOKEN } });
  if (r.status === 429) { await sleep(2000); return shopGet(path); }
  if (!r.ok) throw new Error(`Shopify ${r.status} ${path}: ${(await r.text()).slice(0, 160)}`);
  return r;
}

process.stderr.write(`${PLAN ? "*** PLAN (no writes)" : "*** IMPORT"} — budget ${MAX_SECONDS}s\n`);

// Fetch the 18 collections' type conditions.
const collRules = new Map<string, string[]>();
{
  let pi: string | null = null;
  const wanted = new Set(TARGETS);
  do {
    const params = new URLSearchParams({ limit: "250", fields: "handle,rules" });
    if (pi) params.set("page_info", pi);
    const r = await shopGet(`/smart_collections.json?${params}`);
    const d = await r.json();
    for (const c of (d.smart_collections || [])) {
      if (!wanted.has(c.handle)) continue;
      const conds = (c.rules || []).filter((x: { column: string; condition: string }) => x.column === "type" && x.condition).map((x: { condition: string }) => x.condition);
      collRules.set(c.handle, conds);
    }
    const link = r.headers.get("Link"); const m = link && link.split(",").find((s) => s.includes('rel="next"')); const mm = m && /<([^>]+)>/.exec(m);
    pi = mm ? new URL(mm[1]).searchParams.get("page_info") : null;
  } while (pi);
}
for (const h of TARGETS) if (!collRules.get(h)?.length) process.stderr.write(`  ⚠ ${h}: no type rule found\n`);

// ── runtime pipeline libs (env already set) ──
const { fetchAosomCatalog } = await import("@/lib/csv-fetcher");
const { mergeVariants } = await import("@/lib/variant-merger");
const { queueForImport, generateContent, importToShopify } = await import("@/lib/import-pipeline");
const { createClient } = await import("@libsql/client");

// Imported-SKU set from Turso (skip groups already on Shopify).
const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const importedSkus = new Set<string>();
{
  const rows = await db.execute(`SELECT sku FROM products WHERE shopify_product_id IS NOT NULL AND shopify_product_id <> ''`);
  for (const r of rows.rows) importedSkus.add(String((r as Record<string, unknown>).sku));
}
await db.close?.();
process.stderr.write(`imported SKUs in catalog: ${importedSkus.size}\n`);

// Aosom CSV → groups (PSIN-correct).
process.stderr.write(`fetching Aosom catalog…\n`);
const catalog = await fetchAosomCatalog();
const groups = mergeVariants(catalog);
process.stderr.write(`catalog ${catalog.length} rows → ${groups.length} product groups\n`);

type G = ReturnType<typeof mergeVariants>[number];
const maxQty = (g: G) => Math.max(0, ...g.variants.map((v) => Number(v.qty) || 0));
const anyImported = (g: G) => g.variants.some((v) => importedSkus.has(v.sku));
const hasImage = (g: G) => (g.images || []).some((u) => u && u.trim());

// Selection: per collection (priority order), fill up to PER_COLL TOTAL successes.
// Cap-aware + stable: already-imported successes (from the checkpoint) count toward the 5,
// so a collection that already has >= 5 gets 0 more (no overshoot across resume windows).
// Excludes anything already checkpointed (done/error/skip) and anything already on Shopify.
const chosenKeys = new Set<string>();
const plan: Array<{ handle: string; group: G }> = [];
for (const handle of TARGETS) {
  const conds = (collRules.get(handle) || []).map(norm);
  if (!conds.length) continue;
  const needed = Math.max(0, PER_COLL - (doneSuccessByColl.get(handle) || 0));
  if (needed === 0) continue;
  const cand = groups
    .filter((g) => !chosenKeys.has(g.groupKey) && !done.has(g.groupKey) && !anyImported(g) && hasImage(g) && maxQty(g) > MIN_STOCK && conds.some((c) => norm(g.productType).includes(c)))
    .sort((a, b) => maxQty(b) - maxQty(a))
    .slice(0, needed);
  for (const g of cand) { chosenKeys.add(g.groupKey); plan.push({ handle, group: g }); }
}

// Report the plan.
let curH = "";
for (const { handle, group } of plan) {
  if (handle !== curH) { curH = handle; console.log(`\n──── ${handle} ────`); }
  console.log(`  [${group.groupKey}] q${maxQty(group)}  ${group.variants.length} variant(s)  "${group.name.slice(0, 60)}"  → ${group.variants.map((v) => v.sku).join(",")}`);
}
console.log(`\nPLAN: ${plan.length} produits sur ${TARGETS.length} collections\n`);

if (PLAN) { console.log("── PLAN only, rien importé. ──"); process.exit(0); }

// ── Execute ──
let ok = 0, err = 0, skipped = 0, processed = 0;
for (const { handle, group } of plan) {
  if (done.has(group.groupKey)) { continue; }
  if ((Date.now() - started) / 1000 > MAX_SECONDS) {
    process.stderr.write(`\n⏳ budget ${MAX_SECONDS}s atteint — ${plan.length - done.size - processed} restants. Re-lance pour continuer.\n`);
    break;
  }
  const skus = group.variants.map((v) => v.sku);
  const label = `${handle} / ${group.groupKey} (${group.name.slice(0, 45)})`;
  try {
    const jobs = await queueForImport(skus);
    if (jobs.length === 0) {
      skipped++; done.add(group.groupKey);
      ckpt({ collection: handle, groupKey: group.groupKey, skus, status: "skipped_already_imported" });
      console.log(`  ⏭  SKIP ${label} — déjà importé`);
      continue;
    }
    for (const job of jobs) {
      console.log(`  → gen  ${label} …`);
      await generateContent(job.id);
      console.log(`  → push ${label} …`);
      const res = await importToShopify(job.id);
      ok++;
      ckpt({ collection: handle, groupKey: group.groupKey, skus, status: "done", shopifyId: res.shopifyId, title: res.content?.titleFr });
      console.log(`  ✅ [${ok}] ${label} → Shopify ${res.shopifyId}  "${res.content?.titleFr ?? ""}"`);
    }
    done.add(group.groupKey);
  } catch (e) {
    err++; done.add(group.groupKey); // do NOT retry — avoids duplicate Shopify products on false-timeout
    const msg = e instanceof Error ? e.message : String(e);
    ckpt({ collection: handle, groupKey: group.groupKey, skus, status: "error", error: msg.slice(0, 300) });
    console.log(`  ❌ ERR ${label} — ${msg.slice(0, 160)}`);
  }
  processed++;
  await sleep(PACE_MS);
}

const remaining = plan.filter((p) => !done.has(p.group.groupKey)).length;
process.stderr.write(`\n=== WINDOW END — ok ${ok}, err ${err}, skip ${skipped}, this window ${processed}. Reste ${remaining}. ${Math.round((Date.now() - started) / 1000)}s ===\n`);
if (remaining === 0) process.stderr.write(`\n🎉 PILOT COMPLET — ${plan.length} produits traités.\n`);
