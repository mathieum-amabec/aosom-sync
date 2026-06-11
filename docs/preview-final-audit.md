# Preview final audit — homepage polish

**Date:** 2026-06-11 · **Preview theme:** `160213696617` (unpublished) · **Live `160059195497`
not touched.** Source: `scripts/preview-final-audit.mjs` (read-only Admin-API reads of
`index.json`, `header-group.json`, `featured-collection.liquid`, `mega-menu.liquid`,
`theme.liquid`).

## 1. "livraison gratuite" — 2 mentions (already at target)

| Location | Count |
|---|---|
| `header-group.json` announcement bar | 1 |
| `index.json` → `lc_trustbar` | 1 |

Chantier 3 will move the reassurance "livraison gratuite" into `why_us` (truck icon, **once**),
so `lc_trustbar`'s mention is dropped → final home count stays **2** (announcement bar + why_us).

## 2. Emojis

| Asset | Emojis |
|---|---|
| `index.json` → `featured_sale` heading | **🔥** ("🔥 Meilleures offres du moment") → remove |
| `index.json` → `lc_howit` step icons | 🛋️ 📦 ✨ (illustrative; not in the 🚚🔄🔒⭐🔥 cleanup list — left, noted) |

The reassurance emojis (🚚🔄🔒⭐) are already gone (prior cleanup).

## 3. ALL-CAPS marketing

- `index.json` → `rich_text`: **"PAIEMENT SÉCURISÉ | RETOUR FACILE | SERVICE RAPIDE"** → fix.
- `theme.liquid`: "UMAMI-SETUP" — a code comment marker, **not** marketing (false positive, ignore).

## 4. Redundant / empty sections

- No empty sections.
- **Reassurance is repeated 3×**: `lc_trustbar` (top bar), `rich_text` (caps strip), `why_us`
  (icon grid). The `rich_text` caps strip duplicates the trustbar and is also the CAPS
  offender → **remove it** (kills #3 and the redundancy in one move).
- `lc_story1` + `lc_story2` are two separate story blocks (kept — not redundant content).

## Plan (this PR, PREVIEW only)

1. **why_us premium (Chantier 3):** 4 distinct points (Catalogue 490+ · Livraison gratuite au
   Canada · Retours faciles 30 jours · Service client québécois), navy thin-line SVG icons,
   `#FAFAF8` background. Truck/free-shipping appears here **once**.
2. **`lc_trustbar`:** drop the "Livraison gratuite" span (kept: Retours · Paiement · Service).
3. **Remove `rich_text`** (CAPS + redundant reassurance).
4. **`featured_sale`:** drop the 🔥 from the heading.
5. **Entry popup (Chantier 2):** discreet 10%-off email capture (5s OR 50% scroll, once via
   localStorage, navy/gold DM Sans, FR/EN, close ×, mobile). Email → the native Shopify
   `{% form 'customer' %}` (newsletter → Klaviyo sync), **not** `/api/price-alert` (that is a
   price-drop-alert system that needs a sku/price and sends a different email).
