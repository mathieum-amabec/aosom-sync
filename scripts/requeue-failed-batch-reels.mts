// Put back in the queue the batch Reels (assembly / demand_gen_ext) that were marked 'failed' by the old
// "payload.caption is required" bug and then re-slotted to a later date WITHOUT being reset to 'pending'.
//
// Background (found 2026-10-06): batch-video items had no `caption` in their payload, so every attempt failed until the
// BATCH_VIDEO_ANGLE path in queue-publisher.ts (shipped 2026-10-01) built a real Reel from the product. Rows that had already
// failed were later moved to new slots (Oct 12 - Nov 8) but kept status='failed', so they would never publish.
//
//   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/requeue-failed-batch-reels.mts          # dry run
//   …                                                                scripts/requeue-failed-batch-reels.mts --apply  # reset the safe ones
//
// A row is reset to 'pending' ONLY if all of these hold; otherwise it is left 'failed' and the reason is printed for a human:
//   - its video file is reachable (HTTP 200),
//   - its Shopify product is still active and published,
//   - it is not seasonal content scheduled after the season ended (Halloween after Oct 31),
//   - its title has no price burned in ("68.99$ SEULEMENT" would go stale),
//   - its slot is free (no active row on the same platform/minute).
// Nothing is approved or re-timed here: the slots are the ones the rows already have.
const interop = <T,>(m: T): T => ((m as { default?: T }).default ?? m);
const db = interop(await import("@/lib/database"));
const apply = process.argv.includes("--apply");
const h = await db.ensureSchema();

const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
const SHOP = "https://27u5y2-kp.myshopify.com/admin/api/2025-01";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HALLOWEEN_END = "2026-11-01 04:00:00"; // 2026-11-01 00:00 Toronto, in UTC

const rows = (await h.execute(`SELECT id, content_type, content_id, payload, scheduled_at, error FROM publication_queue
  WHERE status = 'failed' AND content_type IN ('assembly', 'demand_gen_ext') ORDER BY scheduled_at`)).rows as unknown as { id: number; content_type: string; content_id: string; payload: string; scheduled_at: string; error: string | null }[];
console.log(`${rows.length} lignes 'failed' (assembly / demand_gen_ext)\n`);

const ok: number[] = [];
for (const r of rows) {
  let p: { productName?: string; blobUrl?: string; reelsVideoUrl?: string; sku?: string } = {};
  try { p = JSON.parse(r.payload); } catch { /* handled below */ }
  const why: string[] = [];
  const title = String(p.productName ?? "");
  if (!/payload\.caption is required/.test(String(r.error))) why.push(`erreur inattendue : ${String(r.error).slice(0, 60)}`);
  if (/halloween|animatronique|citrouille|fantôme|sorcière|squelette/i.test(`${title} ${p.productName ?? ""}`) && r.scheduled_at >= HALLOWEEN_END) why.push("contenu Halloween planifié APRÈS Halloween");
  if (/\d+[.,]\d{2}\s*\$|\$\s*\d|SEULEMENT/i.test(title)) why.push("prix incrusté dans le titre");
  const blob = p.blobUrl ?? p.reelsVideoUrl;
  if (!blob) why.push("aucun fichier vidéo");
  else {
    const res = await fetch(blob, { method: "HEAD" }).catch(() => null);
    if (!res || !res.ok) why.push(`vidéo inaccessible (HTTP ${res?.status ?? "?"})`);
  }
  const product = await db.getProduct(String(p.sku ?? r.content_id));
  if (!product?.shopify_product_id) why.push("produit sans fiche Shopify");
  else {
    await sleep(550);
    const sr = await fetch(`${SHOP}/products/${product.shopify_product_id}.json?fields=status,published_at`, { headers: { "X-Shopify-Access-Token": TOKEN } });
    const sp = sr.ok ? (await sr.json()).product : null;
    if (!sp || sp.status !== "active" || !sp.published_at) why.push("produit non actif / non publié sur Shopify");
  }
  const clash = (await h.execute({ sql: `SELECT id FROM publication_queue WHERE platform = 'facebook' AND scheduled_at = ? AND id <> ? AND status IN ('pending','publishing','published')`, args: [r.scheduled_at, r.id] })).rows;
  if (clash.length) why.push(`créneau déjà pris (#${(clash[0] as unknown as { id: number }).id})`);
  const local = new Date(Date.parse(`${r.scheduled_at.replace(" ", "T")}Z`) - 4 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
  console.log(`${why.length ? "✗" : "✓"} #${r.id} ${r.content_type.padEnd(14)} ${local} (Toronto)  ${title.slice(0, 48)}${why.length ? `\n      → ${why.join(" ; ")}` : ""}`);
  if (!why.length) ok.push(r.id);
}

console.log(`\n${ok.length} à remettre en attente, ${rows.length - ok.length} laissées en échec pour décision.`);
if (!apply) { console.log("(essai à blanc — rien n'a été modifié)"); process.exit(0); }
if (!ok.length) process.exit(0);
const res = await h.execute(`UPDATE publication_queue SET status = 'pending', error = NULL, claimed_at = NULL WHERE id IN (${ok.join(",")}) AND status = 'failed'`);
console.log(`remises en attente : ${res.rowsAffected}`);
