// One-off: fix the Shop Pay finance block on the LIVE product template.
//  - Remove the hand-computed "Payez en 4 × $XX avec Shop Pay" amount (could be
//    inaccurate vs. real Shop Pay Installments terms).
//  - Keep a branded navy/gold banner (no hardcoded number).
//  - Enlarge the NATIVE <shopify-payment-terms> widget so the real installment
//    amounts (rendered by Shopify) are prominent.
// Target: theme 160059195497 (role: main / published / live).
import { getAsset, putAsset } from "./_shopify-lib.mjs";

const THEME = "160059195497";
const KEY = "templates/product.json";

const NEW_LIQUID = `{%- assign loc = request.locale.iso_code -%}
<style>
  .sp-banner{font-family:'DM Sans',sans-serif;background:#1B2A4A;color:#FFFFFF;border-left:4px solid #D4A853;border-radius:6px;padding:10px 14px;margin:10px 0 4px;font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px;line-height:1.4;}
  .sp-banner__wm{color:#D4A853;font-weight:700;letter-spacing:.2px;}
  shopify-payment-terms{font-size:18px !important;font-weight:600 !important;display:block;margin:8px 0 12px;}
</style>
<p class="sp-banner">
  {% if loc == 'fr' %}💳 Payez en plusieurs versements avec <span class="sp-banner__wm">Shop&nbsp;Pay</span>{% else %}💳 Pay in multiple installments with <span class="sp-banner__wm">Shop&nbsp;Pay</span>{% endif %}
</p>`;

const raw = await getAsset(KEY, THEME);
const tpl = JSON.parse(raw);

const block = tpl?.sections?.main?.blocks?.shop_pay_finance;
if (!block) throw new Error("shop_pay_finance block not found — aborting");

const before = block.settings.custom_liquid;
if (!before.includes("sp-inst")) {
  console.log("⚠️  Block does not contain the expected 'sp-inst' custom line. Current value:");
  console.log(before);
  throw new Error("Unexpected block state — aborting to avoid clobbering");
}

block.settings.custom_liquid = NEW_LIQUID;

const body = JSON.stringify(tpl, null, 2);
const res = await putAsset(KEY, body, THEME);
console.log("PUT status: 200 OK (asset updated)");
console.log("Updated key:", res?.asset?.key, "| theme:", THEME);
console.log("--- New shop_pay_finance custom_liquid ---");
console.log(block.settings.custom_liquid);
