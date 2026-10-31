#!/usr/bin/env node
/**
 * Follow-up to seo-audit-fixes-2026-10-31.mjs (found by the post-apply QA agent): 15 EN meta
 * descriptions that were re-registered while cut mid-word, and 4 products left without one because
 * their EN metafield had a season claim. Rebuilds each from whole sentences only (existing EN value,
 * else custom.body_html_en), drops season claims, appends the free-shipping line.
 *   node-x64 --env-file=.env.local scripts/seo-audit-fix-en-meta-2026-10-31.mjs [--apply]
 */
import { gql, loadEnv, sleep } from "./_shopify-lib.mjs";
loadEnv();
const APPLY = process.argv.includes("--apply");
const HANDLES = ["tricycle-evolutif-6-en-1-tout-petits", "toilette-portable-camping-chasse-eau-20l", "balancoire-double-enfants-auvent-reglable-sirene", "chaise-longue-pliante-exterieure-reglable", "table-poker-ovale-pliable-8-joueurs", "tables-de-chevet-lot-2-tiroir-cabinet", "bureau-informatique-tiroirs-del-prises", "chariot-micro-ondes-rangement-cabinet-2-portes", "foyer-electrique-sur-pied-flamme-realiste-1500w", "bac-jardin-sureleve-galvanise-120x90", "foyer-electrique-27-pouces-manteau", "escalier-3-marches-chien-canape-lit", "causeuse-convertible-double-extraction-chenille", "causeuse-convertible-ottoman-modulaire", "ensemble-bacs-fleurs-empilables-29-po", "abri-rangement-portable-fermeture-eclair", "arbre-bambou-artificiel", "abri-rangement-portable-exterieur-3x3m", "serre-tunnel-portable-acier-pe-120cm"];
const BRAND_RE = /\b(aosom|outsunny|homcom|pawhut|soozier|qaba|vinsetto|costway)\b/i;
const CLAIM_RE = /year[- ]round|all[- ]season|four[- ]season|4[- ]season|winter|snow|canadian (weather|climate|elements)/i;
const CTA_RE = /^(shop|order|buy|get yours|free shipping|add to cart)/i;
const SHIP = " Free shipping across Canada.";
const sentences = (t) => (t.replace(/<(h\d)[^>]*>.*?<\/\1>/gis, " ").replace(/<\/(p|li)>/gi, ". ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&amp;/g, " ").replace(/\s+/g, " ").replace(/\.\s*\./g, ".").match(/[^.!?]+[.!?]/g) || []).map((s) => s.trim());
const build = (srcs) => {
  let out = "";
  for (const src of srcs) for (const s of sentences(src)) {
    if (CLAIM_RE.test(s) || CTA_RE.test(s) || BRAND_RE.test(s) || s.length < 15) continue;
    if ((out + " " + s).trim().length + SHIP.length > 160) { if (out) return out + SHIP; continue; }
    out = (out + " " + s).trim();
  }
  return out ? out + SHIP : null;
};
let bad = 0;
for (const h of HANDLES) {
  const d = (await gql(`query($h:String!){productByHandle(handle:$h){id tEn:metafield(namespace:"custom",key:"title_en"){value} mEn:metafield(namespace:"custom",key:"meta_description_en"){value} bEn:metafield(namespace:"custom",key:"body_html_en"){value} translations(locale:"en"){key value}}}`, { h })).data.productByHandle;
  const cur = d.translations.find((t) => t.key === "meta_description")?.value ?? "";
  let v = build([cur, d.mEn?.value ?? "", d.bEn?.value ?? ""]);
  // Too thin to say what the product is (e.g. starts on a spec): lead with the EN title.
  if (v && v.length < 80 && d.tEn?.value) v = `${d.tEn.value.trim()}. ${v}`;
  const ok = v && v.length >= 60 && v.length <= 160;
  if (!ok) bad++;
  console.log(`\n${h}  [${d.tEn?.value}]\n  OLD: ${cur || "(none)"}\n  NEW (${v?.length}): ${v}${ok ? "" : "  ✘ SKIP"}`);
  if (!APPLY || !ok) continue;
  const dig = (await gql(`query($id:ID!){translatableResource(resourceId:$id){translatableContent{key digest}}}`, { id: d.id })).data.translatableResource.translatableContent.find((c) => c.key === "meta_description")?.digest;
  if (!dig) { console.log("  ✘ no FR meta_description digest"); bad++; continue; }
  const r = await gql(`mutation($id:ID!,$t:[TranslationInput!]!){translationsRegister(resourceId:$id,translations:$t){userErrors{field message}}}`, { id: d.id, t: [{ key: "meta_description", locale: "en", value: v, translatableContentDigest: dig }] });
  const e = r.data?.translationsRegister?.userErrors ?? r.errors;
  if (e?.length) { console.log("  ✘", JSON.stringify(e)); bad++; } else console.log("  ✔ applied");
  await sleep(600);
}
console.log(`\n${APPLY ? "APPLIED" : "DRY-RUN"} — ${bad} problem(s)`);
