// C2 — apply EN-title brand cleanup to the 7 A1 products (no Claude calls; pure string
// cleaning). Translation-sourced titles → translationsRegister; metafield-sourced →
// metafieldsSet(custom.title_en). 2 req/s Shopify. Idempotent (skips if already clean).
import { gql, sleep } from "./_shopify-lib.mjs";

const IDS = ["7736547475561", "7736568971369", "7736571494505", "7736571592809",
  "7736576901225", "7736577228905", "7752208449641"];

const BRANDS = ["Outsunny", "HOMCOM", "Aosom", "Vinsetto", "Kleankin", "Zonekiz",
  "Soozier", "Qaba", "PawHut", "Sportnow", "Aiyaplay", "Rosefray"];
const ordered = [...BRANDS].sort((a, b) => b.length - a.length);
const stripRe = new RegExp("\\b(" + ordered.join("|") + ")\\b", "gi");
function cleanTitle(t) {
  if (!t) return t;
  let s = t.replace(stripRe, "").replace(/\s+/g, " ").replace(/\s*,\s*,\s*/g, ", ")
    .replace(/\s+,/g, ",").replace(/,(?=\S)/g, ", ").replace(/(?:\s[–—-]){2,}\s/g, " — ")
    .replace(/\s+/g, " ").replace(/^[\s,–—-]+/, "").replace(/[\s,–—-]+$/, "");
  return s.trim();
}

const Q = `query($id:ID!){
  node(id:$id){ ... on Product { legacyResourceId metafield(namespace:"custom",key:"title_en"){ value type } translations(locale:"en"){ key value } } }
  translatableResource(resourceId:$id){ translatableContent{ key digest } }
}`;
const M_TRANS = `mutation($id:ID!,$t:[TranslationInput!]!){ translationsRegister(resourceId:$id, translations:$t){ userErrors{ field message } translations{ key value } } }`;
const M_META = `mutation($mf:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$mf){ userErrors{ field message } metafields{ key value } } }`;

let ok = 0, skip = 0, fail = 0;
console.log("C2 — EN-title parity apply (2 req/s)\n" + "─".repeat(60));
for (const id of IDS) {
  const gid = `gid://shopify/Product/${id}`;
  const { data } = await gql(Q, { id: gid });
  const enTrans = (data.node.translations || []).find((t) => t.key === "title")?.value || "";
  const enMeta = data.node.metafield?.value || "";
  const digest = (data.translatableResource.translatableContent || []).find((c) => c.key === "title")?.digest;
  const source = enTrans ? "translation" : (enMeta ? "metafield" : null);
  const before = enTrans || enMeta;
  const after = cleanTitle(before);
  if (!source) { console.log(`#${id}  SKIP (no EN title)`); skip++; continue; }
  if (after === before) { console.log(`#${id}  skip (already clean)`); skip++; continue; }
  try {
    if (source === "translation") {
      const r = await gql(M_TRANS, { id: gid, t: [{ key: "title", locale: "en", value: after, translatableContentDigest: digest }] });
      const e = r.data.translationsRegister.userErrors; if (e.length) throw new Error(JSON.stringify(e));
    } else {
      const type = data.node.metafield?.type || "single_line_text_field";
      const r = await gql(M_META, { mf: [{ ownerId: gid, namespace: "custom", key: "title_en", type, value: after }] });
      const e = r.data.metafieldsSet.userErrors; if (e.length) throw new Error(JSON.stringify(e));
    }
    console.log(`#${id}  OK (${source})\n   avant: ${before}\n   après: ${after}`);
    ok++;
  } catch (err) { console.log(`#${id}  FAIL (${source}): ${err.message}`); fail++; }
  await sleep(550);
}
console.log("─".repeat(60));
console.log(`Rapport : ${ok} OK / ${skip} skip / ${fail} fail  (sur ${IDS.length})`);
