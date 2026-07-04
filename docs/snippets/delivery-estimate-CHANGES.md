# Delivery estimate near CTA + cart — theme change record

Applied to **draft theme `160656818281` only** (live `160606093417` never touched).
Surfaces the estimated delivery delay outside the accordion, near the PDP CTA and the
cart checkout button. Bilingual FR/ER via `request.locale.iso_code`.

## Delay & source of truth
No per-product / per-supplier lead-time data exists (repo, Turso, CSV feed). The number
comes from the store's **published Shipping policy** (`/policies/shipping-policy`):

| Region | Delay |
|---|---|
| Québec, Ontario (core market) | **5–10 business days** |
| Other provinces | 7–14 business days |
| Remote areas | 10–21 business days |
| + processing | 1–3 business days before shipping |

The near-CTA element shows the core-market value **5–10 business days (Qc/Ont)** with a link
to the full regional policy. The product accordion "Livraison, montage & retours" was updated
from a flat "5-10 au Canada" to the full regional breakdown for consistency.

## Files changed (all on draft 160656818281, each PUT → HTTP 200)
1. **`snippets/lc-delivery-estimate.liquid`** (new) — shared bilingual snippet (see
   `lc-delivery-estimate.liquid` in this folder). `compact` param for the cart.
2. **`sections/main-product.liquid`** — `{% render 'lc-delivery-estimate' %}` right after the
   `buy_buttons` render (below "Ajouter au panier", outside the accordion).
3. **`sections/main-cart-footer.liquid`** — `{% render 'lc-delivery-estimate', compact: true %}`
   above `.cart__ctas` (above the Check out button). This theme uses the page cart (no drawer),
   so `snippets/cart-drawer.liquid` also got the same render for completeness/future-proofing.
4. **`snippets/cart-drawer.liquid`** — same compact render before `.cart__ctas` (inactive while
   cart type = page, but consistent if drawer is enabled later).
5. **`templates/product.json`** — `tab_faq` (accordion) FR content → regional delay.
6. **EN translation** of `section.product.json.main.tab_faq.content` registered via
   `translationsRegister` on `OnlineStoreThemeJsonTemplate/product?theme_id=160656818281`.

## Validation (Playwright, draft preview)
- PDP FR: "🚚 Livré en 5–10 jours ouvrables (Qc/Ont) · détails livraison" ✓
- PDP EN: "🚚 Delivered in 5–10 business days (QC/ON) · shipping details" ✓
- Cart FR + EN: same, compact/centered above checkout ✓
- Accordion FR + EN: full regional breakdown ✓
