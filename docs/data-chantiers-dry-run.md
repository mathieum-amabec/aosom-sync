# Data chantiers — DRY-RUN report (2026-06-11)

All three read-only. **No Shopify writes.** Each awaits Mat's validation before any apply.

---

## Chantier 1 — Match counts for 4 proposed smart collections

`scripts/collections-match-dry-run.mjs` — fetched all **502** products and applied each rule
in JS (case-insensitive "contains" on `product_type` + `title`).

| Collection proposée | Produits | Note |
|---|---:|---|
| Électronique et maison | **18** | Mostly **electric ride-on toys** (`électrique`) + 1 fountain. No vacuums/robots in stock — a real "electronics" collection would be thin/misleading. |
| Décoration intérieure | **25** | Mixes genuine interior decor (mirrors, vanity) with **outdoor** lighting (lampadaire solaire) caught by `lampe`/`luminaire`. |
| Jardin et plein air | **195** | Very broad — `jardin` matches garden beds, patio, etc. Heavy overlap with Mobilier extérieur. |
| Enfants et famille | **37** | Cleanest match (toys, kids furniture, ride-ons). |

`product_type` values are detailed **English** Google-taxonomy strings (e.g.
`Toys & Games > … > Electric Toy Cars`); titles are **French**.

**Recommendation:** "Enfants et famille" (37) is worth creating. "Jardin" (195) is too broad
to be useful as-is. "Électronique" and "Décoration" are noisy (toys / outdoor lighting
leaking in) — refine the rules or skip. **STOP — awaiting Mat before creating any collection.**

---

## Chantier 2 — EN-title parity for the 7 A1-cleaned products

`scripts/en-titles-parity-dry-run.mjs`. A1 cleaned the **FR** titles; the **EN** titles still
carry the brand. **7/7 EN titles found** (6 via Translations API, 1 via `custom.title_en`
metafield) — **all 7 would change**:

| # | EN avant | EN après |
|---|---|---|
| 7736547475561 | **Outsunny** 600cm Double Retractable Awning - Black Patio Screen | 600cm Double Retractable Awning - Black Patio Screen |
| 7736568971369 | **Outsunny** 10 x 13 ft. Gazebo with Mosquito Netting Walls - Garden Tent | 10 x 13 ft. Gazebo with Mosquito Netting Walls - Garden Tent |
| 7736571494505 | **Outsunny** 3x3m Gazebo Hardtop Galvanized Steel Aluminum Frame Dark Grey | 3x3m Gazebo Hardtop Galvanized Steel Aluminum Frame Dark Grey |
| 7736571592809 | **Outsunny** 10' x 12' Hardtop Gazebo Galvanized Steel Roof Aluminum Frame | 10' x 12' Hardtop Gazebo Galvanized Steel Roof Aluminum Frame |
| 7736576901225 | **Outsunny** 4 Pcs Rattan Patio Set - Thick Cushions, Mixed Grey | 4 Pcs Rattan Patio Set - Thick Cushions, Mixed Grey |
| 7736577228905 | **Outsunny** 196cm Solar Outdoor Motion Sensor Floor Lamp Black | 196cm Solar Outdoor Motion Sensor Floor Lamp Black |
| 7752208449641 | **Aosom** Kids Pedal Go Kart - Steel Frame with Hand Brake System | Kids Pedal Go Kart - Steel Frame with Hand Brake System |

**Apply path (when validated):** 6 are **translations** → `translationsRegister`; 1 is the
**`custom.title_en` metafield** → `metafieldsSet`. **STOP — awaiting Mat.**

---

## Chantier 3 — Phase-0 P0 remediation status

`scripts/p0-remediation-audit.mjs` scanned all **502** products (497 ACTIVE / 5 DRAFT).

Per `docs/audit-pdp-video.md` the Phase-0 verdict was **no security/reliability P0/P1**. The
two perceived "duplicate title" symptoms, re-checked now:

1. **Leading marketing heading in `body_html` — STILL PRESENT: 26 / 502** (vs 14/250 in the
   Phase-0 sample). Claude-generated descriptions open with an `<h2>`/`<h3>` marketing line
   right under the product `<h1>` (e.g. "Lampadaire Solaire Élégant avec Technologie
   Moderne") → reads as a second title. Several headings even **repeat the brand** ("Canapé 3
   Places de Luxe **Aosom**").
   - **CSS or data?** → **DATA.** A CSS rule could hide the first heading in
     `.product__description`, but that (a) risks hiding legitimate section headings, (b) leaves
     the heading in the HTML/SEO/structured-data, and (c) doesn't remove the leaked brand. The
     robust fix is data: strip a leading `<h1-3>` from `body_html` on push
     (`shopify-client.ts`) **and backfill the 26 existing**. (Matches audit recommendation #1.)
2. **Draft products showing "2 H1" — NOT a PDP bug (confirmed).** Only 5 products are DRAFT;
   draft URLs **redirect to the home** (H1=2: empty logo + tagline, plus H2-links). Inspecting
   a draft via its public URL shows the home, not the PDP. **Published PDPs render 1 H1**
   (template has a single `title` block). No PDP fix needed.
3. **`##` markdown literal — 0 / 502** (not reproducible; matches audit). Risk remains
   structural (no markdown→HTML conversion on push) but nothing to remediate today.

**Remaining actionable item:** the **26** leading-heading descriptions → a data strip
(on-push + backfill), ideally bundled with the EN/FR brand cleanup. **No security P0/P1
outstanding.**
