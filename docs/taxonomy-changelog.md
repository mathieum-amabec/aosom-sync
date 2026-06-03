# Taxonomy changelog — outdoor collections (plans 5B + 5C)

> Store: `27u5y2-kp.myshopify.com` · Admin API `2025-01` · executed 2026-06-03
> Tooling: `scripts/taxonomy-audit.js` (read-only) and `scripts/taxonomy-build.js`
> (idempotent, dry-run by default, `--apply` to write).

These changes live **in Shopify** (product tags + smart-collection rules), not in
application code. This document is the audit trail; the scripts reproduce the state.

## Plan 5B — bbq-cuisson tagging + collection rewrites

- Tagged **34 products** with `bbq-cuisson` (append-only). Set = all 35 `BBQ`-tagged
  products ∪ 7 explicit IDs (4 chariots + 3 foyers 2-en-1) **minus 3 gazebos**
  (`7750893568105`, `7736568971369`, `7736569987177`) which are shelters, not cooking gear.
- Rewrote smart collection **BBQ et articles de cuisson extérieurs** (`314845462633`):
  was `tag=BBQ AND title~Grill AND title~BBQ` (4 members) → now `tag equals "bbq-cuisson"` (**34**).
- Rewrote smart collection **Foyers extérieurs** (`314845495401`):
  was `title~Firepit/Fire/Foyer` (OR) → now `tag equals "foyer extérieur"` (**3**, unchanged set).
- The 3 foyers 2-en-1 are intentionally dual-collection (bbq-cuisson + foyer extérieur).

## Plan 5C — new outdoor smart collections

Tagged **198 unique products** (226 tag-assignments; 28 products matched >1 collection
and got multiple tags in a single PUT). Created **5 smart collections**:

| FR title | EN title (pending) | tag | members | source | id | published |
|---|---|---|--:|---|---|---|
| Ensembles de patio | Patio Sets | `patio-ensemble` | 24 | curated title match (excl. raised beds / cushions / nightstands) | `473346146409` | yes |
| Chaises et tables de patio | Patio Chairs & Tables | `chaise-table-patio` | 91 | migrated members of custom `312997806185` | `473346179177` | no |
| Gazébos, parasols et abris | Gazebos, Canopies & Shelters | `gazebo-abri` | 28 | migrated members of custom `312997707881` | `473346211945` | no |
| Jardinage et serres | Gardening & Greenhouses | `jardinage-serre` | 77 | migrated members of custom `312997740649` | `473346244713` | no |
| Rangement extérieur | Outdoor Storage | `rangement-exterieur` | 6 | explicit outdoor-only allow-list | `473346277481` | yes |

### Decisions
- **#2/#3/#4** already existed as **manual (custom)** collections. We migrated their exact
  current members to tag-based **smart** collections and **kept the old custom collections
  intact**. The new smart versions are **unpublished** to avoid duplicate live collections;
  flip them live once the old custom ones are retired.
- **#1 / #5** were curated, because fuzzy substring matching is unsafe here
  (`"table"` matches `"ré-table"` in *rétractable* / *tablette*; `"chauffage"` matches
  `"ré-chauffage"`; `"rangement"` matches indoor desks/buffets/TV stands).
- **#6 (Foyers/chauffage)**: **not created** — 0 net-new heating products
  (no braseros / patio heaters in catalog); merged into existing *Foyers extérieurs*.
- **#7 (BBQ & Outdoor Kitchen)**: already exists as `bbq-cuisson` (34) from 5B — unchanged.

## ⛔ Blocked: EN translations

EN collection titles could **not** be set. The Admin token lacks the Translations API
scopes (confirmed via GraphQL `ACCESS_DENIED`):

- `shopLocales` → needs `read_locales` (or `read_markets_home`)
- `translatableResource` → needs `read_translations`
- `translationsRegister` will also need `write_translations`

**To unblock:** Shopify admin → custom app → API scopes → add `read_translations`,
`write_translations`, `read_locales` → reinstall → update `SHOPIFY_ACCESS_TOKEN` in
`.env.local`. Then a translations-only pass can register the EN titles in the table above.

## ⚠️ Observed: manual tags can be stripped by product refresh

Shortly after 5C, **4 of the 6** `rangement-exterieur` products lost the tag (the
collection silently dropped to 2 members) — a product refresh/sync overwrote the
manually-added tag. They were re-applied via `taxonomy-build.js --apply`. If catalog
sync rewrites tags, these slug tags need to be re-asserted (the build script is
idempotent and re-syncs any missing tags on `--apply`). Worth confirming the sync/import
path preserves non-Aosom tags.

## Follow-ups
1. Add translation scopes + run the EN-title pass (7 collections).
2. Retire the old custom collections (`312997806185`, `312997707881`, `312997740649`)
   once the smart versions are verified, then publish the smart `#2/#3/#4`.
3. Verify the sync/import pipeline preserves manual tags (see warning above); if not,
   schedule a periodic `taxonomy-build.js --apply` re-sync.
