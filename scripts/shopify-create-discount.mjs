// Create the BIENVENUE10 welcome discount in Shopify (10% off, once per customer,
// no expiry) — the coupon the Klaviyo Welcome flow hands out.
//
// SAFE BY DEFAULT: no flag = DRY-RUN (checks whether the code already exists and
// prints the exact payloads it WOULD POST, sends nothing). --apply creates it.
//
//   node scripts/shopify-create-discount.mjs           # dry-run (default)
//   node scripts/shopify-create-discount.mjs --apply    # create the price rule + code
//
// On Windows ARM run under x64 node (global fetch): see CLAUDE.md / dev.ps1.
//
// Shopify models a discount as a PRICE RULE (the rule: 10% off, once per customer)
// plus a DISCOUNT CODE (the string customers type: BIENVENUE10). Idempotent: --apply
// skips creation if a price rule titled BIENVENUE10 already exists.
import { rest } from "./_shopify-lib.mjs";

const APPLY = process.argv.includes("--apply");
const CODE = "BIENVENUE10";
const line = "=".repeat(72);
const die = (msg) => { console.error(`\nERREUR: ${msg}`); process.exit(1); };

// starts_at is required by Shopify; no ends_at → no expiration.
const startsAt = new Date().toISOString();

const priceRulePayload = {
  price_rule: {
    title: CODE,
    target_type: "line_item",
    target_selection: "all",
    allocation_method: "across",   // required for percentage value_type
    value_type: "percentage",
    value: "-10.0",                // negative = a discount of 10%
    customer_selection: "all",
    once_per_customer: true,       // "usage : once per customer"
    usage_limit: null,             // no global cap (only the per-customer cap above)
    starts_at: startsAt,
    // ends_at intentionally omitted → no expiration date
  },
};
const discountCodePayload = { discount_code: { code: CODE } };

async function findExistingRule() {
  // Look the code up directly; lookup 303-redirects to the code resource when it exists.
  const res = await rest(`/discount_codes/lookup.json?code=${encodeURIComponent(CODE)}`);
  if (res.ok) {
    const j = await res.json().catch(() => ({}));
    return j.discount_code || { code: CODE, found: true };
  }
  if (res.status === 404) return null;
  // Fallback: scan price rules by title.
  const list = await rest(`/price_rules.json?limit=250`);
  if (!list.ok) die(`Shopify price_rules.json → ${list.status} ${await list.text()}`);
  const rules = (await list.json()).price_rules || [];
  return rules.find((r) => r.title === CODE) || null;
}

async function main() {
  console.log(`${line}\nSHOPIFY DISCOUNT "${CODE}" — ${APPLY ? "APPLY (création réelle)" : "DRY-RUN (aucun envoi)"}\n${line}`);

  const existing = await findExistingRule();
  console.log(`\nCode "${CODE}" déjà présent : ${existing ? "OUI — " + JSON.stringify(existing).slice(0, 200) : "non"}`);

  console.log(`\n${line}\nÉTAPE A — POST /price_rules.json\n${line}`);
  console.log(JSON.stringify(priceRulePayload, null, 2));
  console.log(`\n${line}\nÉTAPE B — POST /price_rules/{price_rule_id}/discount_codes.json\n${line}`);
  console.log(JSON.stringify(discountCodePayload, null, 2));

  if (!APPLY) {
    console.log(`\n${line}\nDRY-RUN terminé — rien n'a été envoyé. Relancer avec --apply pour créer.\n${line}`);
    return;
  }

  if (existing && existing.price_rule_id) {
    console.log(`\n[skip] Code déjà présent (price_rule_id ${existing.price_rule_id}) — aucune création.`);
    return;
  }

  // ÉTAPE A: create the price rule
  const ruleRes = await rest(`/price_rules.json`, { method: "POST", body: JSON.stringify(priceRulePayload) });
  if (!ruleRes.ok) die(`POST /price_rules → ${ruleRes.status} ${await ruleRes.text()}`);
  const ruleId = (await ruleRes.json()).price_rule.id;
  console.log(`\n[ok] Price rule créée : ${ruleId}`);

  // ÉTAPE B: create the discount code under it
  const codeRes = await rest(`/price_rules/${ruleId}/discount_codes.json`, { method: "POST", body: JSON.stringify(discountCodePayload) });
  if (!codeRes.ok) die(`POST /discount_codes → ${codeRes.status} ${await codeRes.text()}`);
  const created = (await codeRes.json()).discount_code;
  console.log(`[ok] Code créé : "${created.code}" (id ${created.id}) → 10% off, once per customer, sans expiration.`);
  console.log(`\n${line}\nTerminé.\n${line}`);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
