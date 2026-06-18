/**
 * Debrand Shopify product DESCRIPTIONS (body_html) → remove supplier brand names.
 *
 * Hybrid strategy:
 *   - MECHANICAL strip for the clean majority (brand word removed + spacing/punctuation fixed).
 *   - CLAUDE rewrite for the minority where a plain strip breaks grammar
 *     (brand after a preposition then punctuation — "cat tree from Aosom," → "from,";
 *      or brand at the start of a sentence — "Aosom vous propose…").
 *
 * Usage:
 *   node scripts/fix-shopify-descriptions.mjs            # DRY-RUN (no writes) — default
 *   node scripts/fix-shopify-descriptions.mjs --apply    # execute the PUTs
 *
 * Requires SHOPIFY_ACCESS_TOKEN (always) and ANTHROPIC_API_KEY (rewrite path / dry-run samples).
 * Rate limit: 2 req/sec strict on Shopify writes (>=500ms); Claude calls 2s apart.
 */
import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync } from "node:fs";

const STORE = "27u5y2-kp.myshopify.com";
const API = "2024-01";
const MODEL = "claude-sonnet-4-6";
const RL_MS = 500;
const CLAUDE_RL_MS = 2000;

const BRANDS = "Aosom|Outsunny|HOMCOM|HomCom|Qaba|Soozier|Vinsetto|Pawhut|PawHut";
const BRAND_RE = () => new RegExp(`\\b(${BRANDS})\\b`, "gi");
// Breakage signals (on plain text) that route a product to the Claude rewrite path:
const PREP_PUNCT = new RegExp(`\\b(from|by|with|of|de|du|des)\\s+(${BRANDS})\\s*[,.;:]`, "i");
const SENT_START = new RegExp(`(^|[.!?]\\s+)(${BRANDS})\\b`, "i");

const APPLY = process.argv.includes("--apply");
const shopToken = process.env.SHOPIFY_ACCESS_TOKEN;
const anthropicKey = process.env.ANTHROPIC_API_KEY;
if (!shopToken) { console.error("ERROR: SHOPIFY_ACCESS_TOKEN not set"); process.exit(1); }
const SH = { "X-Shopify-Access-Token": shopToken, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (h) => (h || "").replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();

const anthropic = anthropicKey ? new Anthropic({ apiKey: anthropicKey, timeout: 60_000, maxRetries: 3 }) : null;

/** Mechanical debrand: drop the brand word, fix the spacing/punctuation it left behind. */
function mechanical(html) {
  return html
    .replace(BRAND_RE(), "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([(«“])\s+/g, "$1")
    .replace(/\s+([)»”])/g, "$1")
    .replace(/\bL'\s+/g, "L'")
    .replace(/\bd'\s+/gi, "d'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+\n/g, "\n");
}

/** A product needs the Claude rewrite when a mechanical strip would leave broken grammar. */
function needsRewrite(text) {
  return PREP_PUNCT.test(text) || SENT_START.test(text);
}

/** Claude rewrite: remove the brand, change nothing else. */
async function claudeRewrite(html) {
  if (!anthropic) throw new Error("ANTHROPIC_API_KEY not set (needed for the rewrite path)");
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system:
      "Tu nettoies des descriptions produit. Retire TOUTE mention de marque fournisseur " +
      "(Aosom, Outsunny, HOMCOM, Qaba, Soozier, Vinsetto, PawHut) en gardant EXACTEMENT le reste : " +
      "même sens, même HTML, même langue, mêmes phrases. Corrige uniquement la grammaire et la " +
      "ponctuation autour de la mention retirée. Ne reformule pas le reste. " +
      "Réponds UNIQUEMENT avec le HTML nettoyé, sans commentaire ni fences.",
    messages: [{ role: "user", content: html }],
  });
  // Truncated output would still pass the brand-absence guard but silently drop content — refuse it.
  if (res.stop_reason === "max_tokens") throw new Error("réécriture tronquée (max_tokens) — non écrit");
  const out = (res.content.find((b) => b.type === "text")?.text ?? "").trim();
  return out.replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

async function fetchAffected() {
  const out = [];
  let url = `https://${STORE}/admin/api/${API}/products.json?fields=id,title,body_html&limit=250`;
  while (url) {
    const r = await fetch(url, { headers: SH });
    if (!r.ok) throw new Error(`list HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    for (const p of data.products) {
      if (BRAND_RE().test(p.body_html || "")) out.push(p);
    }
    const m = (r.headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
    await sleep(RL_MS);
  }
  return out;
}

async function putBody(id, body) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://${STORE}/admin/api/${API}/products/${id}.json`, {
      method: "PUT", headers: SH, body: JSON.stringify({ product: { id, body_html: body } }),
    });
    if (r.status === 429) {
      if (attempt >= 6) throw new Error(`PUT ${id}: rate-limited after ${attempt} retries`);
      await sleep((Number(r.headers.get("retry-after")) || 2) * 1000); continue;
    }
    if (!r.ok) throw new Error(`PUT ${id} HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`);
    return;
  }
}

const snippet = (text, re) => {
  const i = text.search(re); if (i < 0) return text.slice(0, 140);
  return "…" + text.slice(Math.max(0, i - 55), i + 75).trim() + "…";
};

const all = await fetchAffected();
const mech = all.filter((p) => !needsRewrite(plain(p.body_html)));
const rew = all.filter((p) => needsRewrite(plain(p.body_html)));
console.log(`Mode            : ${APPLY ? "APPLY (writes to Shopify)" : "DRY-RUN (no writes)"}`);
console.log(`Descriptions avec marque fournisseur : ${all.length}`);
console.log(`  → strip mécanique  : ${mech.length}`);
console.log(`  → réécriture Claude : ${rew.length}`);

if (!APPLY) {
  // Show up to 3 mechanical + up to 2 Claude examples, before/after.
  const samples = [...mech.slice(0, 3), ...rew.slice(0, 2)];
  console.log(`\n[DRY-RUN] ${samples.length} exemples avant/après :`);
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    const isRew = needsRewrite(plain(p.body_html));
    const beforeP = plain(p.body_html);
    console.log(`\n[${i + 1}] ${(p.title || "").slice(0, 58)}  (${isRew ? "CLAUDE" : "MÉCANIQUE"})`);
    if (isRew) {
      // Show the full plain text (truncated) from the start so before/after are comparable —
      // lets the reader confirm Claude only removed the brand, not reworded the copy.
      let after;
      try { after = plain(await claudeRewrite(p.body_html)); await sleep(CLAUDE_RL_MS); }
      catch (e) { after = `[Claude indisponible: ${e.message}]`; }
      console.log(`  AVANT (${beforeP.length}c) : ${beforeP.slice(0, 230).trim()}…`);
      console.log(`  APRÈS (${after.length}c) : ${after.slice(0, 230).trim()}…`);
    } else {
      // Show the aligned window around where the brand was, before vs mechanically stripped.
      const idx = beforeP.search(BRAND_RE());
      const win = beforeP.slice(Math.max(0, idx - 55), idx + 75);
      console.log(`  AVANT : …${win.trim()}…`);
      console.log(`  APRÈS : …${mechanical(win).replace(/\s+([,.;:!?])/g, "$1").trim()}…`);
    }
  }
  console.log(`\nDry-run terminé. ${all.length} descriptions seraient nettoyées (${mech.length} mécanique + ${rew.length} Claude). Relancer avec --apply pour exécuter.`);
  process.exit(0);
}

// --apply
// Snapshot every original body_html before touching anything — the PUT is irreversible.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `descriptions-backup-${stamp}.json`;
writeFileSync(backupPath, JSON.stringify(all.map((p) => ({ id: p.id, title: p.title, body_html: p.body_html })), null, 2));
console.log(`Backup des originaux : ${backupPath} (${all.length} descriptions)`);

console.log(`\nApplication sur ${all.length} descriptions…`);
let ok = 0, fail = 0;
for (let i = 0; i < all.length; i++) {
  const p = all[i];
  const isRew = needsRewrite(plain(p.body_html));
  try {
    let body;
    if (isRew) { body = await claudeRewrite(p.body_html); await sleep(CLAUDE_RL_MS); }
    else { body = mechanical(p.body_html); }
    if (BRAND_RE().test(plain(body))) throw new Error("marque encore présente après nettoyage — non écrit");
    // Removing a brand word trims ~10 chars; a >40% drop means truncation or mangling, not a clean strip.
    const beforeLen = plain(p.body_html).length, afterLen = plain(body).length;
    if (afterLen < beforeLen * 0.6) throw new Error(`sortie trop courte (${afterLen} vs ${beforeLen}c) — non écrit`);
    await putBody(p.id, body); ok++;
    console.log(`[${i + 1}/${all.length}] #${p.id} ${isRew ? "Claude " : "mécanique"} ✓  ${(p.title || "").slice(0, 45)}`);
  } catch (e) { fail++; console.error(`[${i + 1}/${all.length}] #${p.id} ÉCHEC : ${e.message}`); }
  await sleep(RL_MS);
}
console.log(`\nApply terminé. OK : ${ok}, échecs : ${fail}.`);
process.exit(fail ? 1 : 0);
