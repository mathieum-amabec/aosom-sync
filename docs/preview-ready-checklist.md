# Preview ready checklist — thème `160213696617` ("Copie de Copie de Trade v2", unpublished)

Audit du 2026-06-11. Lecture seule via Shopify Admin API (377 assets). Live (`160059195497`, role:main) non touché.
Scripts: `scripts/preview-ready-audit.mjs`, `preview-audit-pdp.mjs`, `preview-audit-tiles.mjs`.

## Homepage (`templates/index.json`)

Ordre des sections : `lc_hero → lc_trustbar → shop_pay_home → home_video → featured_sale → lc_story1 → cat_tiles → featured_collection2 → lc_story2 → why_us → [apps] → lc_blog → lc_howit → lc_trust → lc_loop → entry_popup`

| Item | Statut | Preuve |
|---|---|---|
| Section vidéo repositionnée (avant les carrousels) | ✅ | `home_video` @index 3, avant le 1er carrousel `featured-collection` @index 4 |
| Desktop : poster statique, vidéo au hover | ✅ | `(hover:hover) and (pointer:fine)` + `preload="none"` + `poster=` présents |
| Mobile : autoplay muted loop | ✅ | `IntersectionObserver` + `muted` + `loop` présents |
| Méga-menu toutes catégories (Mobilier ext / Meubles / Animaux / Enfants) | ✅ | `snippets/mega-menu.liquid` référence les 4 catégories |
| Tuiles catégories avec images | ⚠️ ✅ | `cat_tiles` a des images (CDN Shopify, `.jpg/.png/.webp`). Provenance "Unsplash" non vérifiable depuis l'asset (images uploadées sur le CDN) |
| Popup première commande présent | ✅ | `entry_popup` présent dans l'ordre |
| why_us 4 icônes SVG navy | ✅ | `why_us` : 4 `<svg>`, couleur `#1B2A4A` |
| Max 2 mentions "livraison gratuite" | ✅ | 1 mention trouvée dans les sections `index.json` (≤ 2) |
| 0 liquid error | ⚠️ ✅ | Tags `{% %}` équilibrés + schémas valides sur tous les assets audités. Vérif. complète d'erreurs runtime nécessite un rendu storefront (bloqué : preview non publié, pas de session admin headless) |

## Page "Voyez-le chez vous"

| Item | Statut | Preuve |
|---|---|---|
| Page Shopify créée (handle: `voyez-le-chez-vous`) | ✅ | page existe, `published_at` non nul |
| Template `page.voyez-le.json` présent | ✅ | `templates/page.voyez-le.json` + `template_suffix: voyez-le` |
| 15 cartes vidéo avec filtres catégorie | ✅ | `sections/page-voyez-le.liquid` : 16 réfs `all_products[...]` (≈15 cartes), filtre catégorie présent |
| Lien dans le menu | ✅ | "Voyez-le chez vous" trouvé dans les menus (GraphQL) |

## PDP (`sections/main-product.liquid` + `templates/product.json`)

Blocs template : `main-product`, `related-products`, `apps`.

| Item | Statut | Preuve |
|---|---|---|
| Eyebrow catégorie | ✅ | motif eyebrow/catégorie présent dans `main-product.liquid` |
| Badge Judge.me sous H1 | ✅ | `jdgm`/judge.me référencé |
| ATC navy | ✅ | `#1B2A4A` (5 occurrences) dans `main-product.liquid` |
| Swatches couleur 69 entrées FR/EN | ⚠️ | Swatches présents, logique couleur **bilingue** confirmée dans `main-product.liquid` (18 noms FR + marqueurs EN). Le compte exact "69" est côté app (`src/lib/variant-merger.ts` COLOR_MAP) / métachamps, non vérifiable depuis l'asset thème |
| Cross-sell "Vous aimerez aussi" | ✅ | `sections/related-products.liquid` + heading "aimerez aussi" |

## Verdict

**PRÊT À PUBLIER** — toutes les fonctionnalités structurelles sont en place. 3 items demandent une confirmation visuelle manuelle (non vérifiables depuis l'API seule) :

1. **Tuiles catégories** — confirmer visuellement que les images CDN sont bien les visuels Unsplash voulus.
2. **Swatches 69 entrées** — le compte vit côté app/métachamps ; confirmer le rendu des pastilles sur une PDP réelle.
3. **0 liquid error** — équilibrage des tags OK ; faire un dernier coup d'œil au storefront preview (lien admin "Prévisualiser") avant publication pour capter d'éventuelles erreurs runtime.

Aucun ❌ bloquant trouvé.
