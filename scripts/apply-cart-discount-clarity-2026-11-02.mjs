#!/usr/bin/env node
/**
 * Cart clarity fixes (mystery-shopper audit 2026-11-01), theme part.
 *
 * 1. The automatic "10% sur le 2e article" (BXGY) discount label was printed on EVERY line it touches,
 *    including the full-price item (allocation amount 0) → shoppers read "10 %" on their 160 $ table
 *    and see no reduction. Now: a line shows the label only when it really got money off, with the amount.
 * 2. No "you save" line anywhere in the cart → add "Vous économisez X $" above the estimated total
 *    (drawer + /cart) whenever cart.total_discount > 0.
 * 3. /cart footer said "(Qc/Ont)" while the drawer says "(Qc/Ont/Maritimes)" → drop the region
 *    from the /cart note (shipping is free everywhere in Canada).
 *
 * Exact-substring patches on the TARGET draft's own files, written only to an UNPUBLISHED theme
 * (putAsset → assertWritableTheme).
 *   node-x64 --env-file=.env.local scripts/apply-cart-discount-clarity-2026-11-02.mjs --theme=<draftId>          # dry-run
 *   node-x64 --env-file=.env.local scripts/apply-cart-discount-clarity-2026-11-02.mjs --theme=<draftId> --apply
 */
import fs from "node:fs";
import path from "node:path";
import { getAsset, getDraftThemeId, putAsset, loadEnv, sleep } from "./_shopify-lib.mjs";

loadEnv();
const THEME_ARG = process.argv.find((a) => a.startsWith("--theme="))?.split("=")[1];
const APPLY = process.argv.includes("--apply");

const LOC = "request.locale.iso_code";
const savings = (cls) => `{%- if cart.total_discount > 0 -%}
            <p class="lc-cart-savings ${cls}" style="margin:0 0 .6rem;font-size:1.4rem;font-weight:700;color:#2D7A3A">
              {%- if ${LOC} == 'en' -%}You save{%- elsif ${LOC} == 'es' -%}Ahorras{%- elsif ${LOC} == 'pa' -%}ਤੁਸੀਂ ਬਚਾਉਂਦੇ ਹੋ{%- else -%}Vous économisez{%- endif -%}
              {{ ' ' }}{% render 'lc-money', amount: cart.total_discount %}
            </p>
          {%- endif -%}
          `;

const PATCHES = {
  "snippets/cart-drawer.liquid": [
    [
      `{%- for discount in item.line_level_discount_allocations -%}
                              <li class="discounts__discount">
                                {{- 'icon-discount.svg' | inline_asset_content -}}
                                {{ discount.discount_application.title }}
                              </li>
                            {%- endfor -%}`,
      `{%- for discount in item.line_level_discount_allocations -%}
                              {%- if discount.amount > 0 -%}
                              <li class="discounts__discount">
                                {{- 'icon-discount.svg' | inline_asset_content -}}
                                {{ discount.discount_application.title }} (-{% render 'lc-money', amount: discount.amount %})
                              </li>
                              {%- endif -%}
                            {%- endfor -%}`,
    ],
    [
      `          <div class="totals" role="status">
            <h2 class="totals__total">{{ 'sections.cart.estimated_total' | t }}</h2>`,
      `          ${savings("lc-cart-savings--drawer")}<div class="totals" role="status">
            <h2 class="totals__total">{{ 'sections.cart.estimated_total' | t }}</h2>`,
    ],
  ],
  "sections/main-cart-items.liquid": [
    [
      `{%- for discount in item.line_level_discount_allocations -%}
                          <li class="discounts__discount">
                            {{- 'icon-discount.svg' | inline_asset_content -}}
                            {{ discount.discount_application.title | escape }}
                          </li>
                        {%- endfor -%}`,
      `{%- for discount in item.line_level_discount_allocations -%}
                          {%- if discount.amount > 0 -%}
                          <li class="discounts__discount">
                            {{- 'icon-discount.svg' | inline_asset_content -}}
                            {{ discount.discount_application.title | escape }} (-{% render 'lc-money', amount: discount.amount %})
                          </li>
                          {%- endif -%}
                        {%- endfor -%}`,
    ],
  ],
  "sections/main-cart-footer.liquid": [
    [
      `                <div class="totals">
                  <h2 class="totals__total">{{ 'sections.cart.estimated_total' | t }}</h2>`,
      `                ${savings("lc-cart-savings--page")}<div class="totals">
                  <h2 class="totals__total">{{ 'sections.cart.estimated_total' | t }}</h2>`,
    ],
    [
      `🚚 Free shipping included · 4-8 business days (QC/ON)`,
      `🚚 Free shipping across Canada · 4-8 business days`,
    ],
    [`🚚 Envío gratis incluido · 4-8 días hábiles (QC/ON)`, `🚚 Envío gratis a todo Canadá · 4-8 días hábiles`],
    [`🚚 ਮੁਫ਼ਤ ਸ਼ਿਪਿੰਗ ਸ਼ਾਮਲ ਹੈ · 4-8 ਕੰਮਕਾਜੀ ਦਿਨ (QC/ON)`, `🚚 ਮੁਫ਼ਤ ਸ਼ਿਪਿੰਗ ਸ਼ਾਮਲ ਹੈ · 4-8 ਕੰਮਕਾਜੀ ਦਿਨ`],
    [`🚚 Livraison GRATUITE · 4 à 8 jours ouvrables (Qc/Ont)`, `🚚 Livraison GRATUITE partout au Canada · 4 à 8 jours ouvrables`],
  ],
};

const theme = await getDraftThemeId(THEME_ARG ? { themeId: THEME_ARG } : {});
console.log(`target draft: ${theme}${APPLY ? "" : " (dry-run)"}`);
const out = {};
for (const [key, list] of Object.entries(PATCHES)) {
  let v = await getAsset(key, theme);
  // Some theme files use CRLF line endings: match and write in the file's own convention.
  const crlf = v.includes("\r\n");
  for (let [from, to] of list) {
    if (crlf) [from, to] = [from, to].map((s) => s.replace(/\r?\n/g, "\r\n"));
    const n = v.split(from).length - 1;
    if (n !== 1) throw new Error(`${key}: patch matched ${n}× (expected 1): ${from.slice(0, 80)}`);
    v = v.replace(from, () => to);
  }
  out[key] = v;
  await sleep(300);
}
for (const [k, v] of Object.entries(out)) {
  const f = path.join(".context/cart-fix/patched", k);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, v);
}
if (!APPLY) {
  console.log(`dry-run OK: ${Object.keys(out).length} files patched → .context/cart-fix/patched/ (re-run with --apply)`);
  process.exit(0);
}
for (const [k, v] of Object.entries(out)) {
  await putAsset(k, v, theme);
  console.log(`✓ ${k}`);
  await sleep(600);
}
console.log(`applied to unpublished theme ${theme}`);
