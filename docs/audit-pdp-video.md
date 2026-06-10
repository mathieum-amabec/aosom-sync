# Audit PDP + Vidéos — Phase 0 (lecture seule)

**Date:** 2026-06-10 · **Branche:** `chore/audit-pdp-video` · **Thème live:** `160059195497`
**Méthode:** lecture du code (`src/`), requêtes read-only Turso + Shopify Admin API
(scripts `scripts/audit-pdp-*.mjs`, `scripts/audit-home-pdp.mjs`,
`scripts/audit-collections.mjs`). **Aucune écriture** (DB ni Shopify ni thème).

---

## 1. Choix de l'image vedette à l'import (Job 3)

**Oui, il y a une logique de priorité lifestyle vs fond blanc.**

Point d'entrée de la curation: `queueForImport()` —
`src/lib/import-pipeline.ts:62` appelle `selectProductImages(rawProduct.images)`.
La curation se fait **uniquement à l'import** (pas au sync quotidien, pour ne pas
re-imager des produits déjà en ligne).

Fonction exacte: `selectProductImages()` — `src/lib/variant-merger.ts:218-231`:

```ts
export function selectProductImages(images: string[]): string[] {
  const filtered = images.filter((url) => {
    const dim = smallestUrlDimension(url);
    return dim === null || dim >= MIN_IMAGE_PX;        // drop < 800px si détectable
  });
  const idx = filtered.findIndex((url) => LIFESTYLE_RE.test(url));
  const ordered =
    idx > 0
      ? [filtered[idx], ...filtered.slice(0, idx), ...filtered.slice(idx + 1)]  // lifestyle → position 0
      : filtered;                                       // sinon ordre CSV
  return ordered.slice(0, MAX_IMAGES_PER_PRODUCT);      // cap 8
}
```

- **Promotion lifestyle:** `LIFESTYLE_RE = /lifestyle|ambiance|room/i` (`variant-merger.ts:188`).
  La **première** image dont l'URL matche est déplacée en position 0.
- **Pas de pénalité fond blanc:** le code ne détecte ni ne dé-priorise les photos
  sur fond blanc. Si aucune URL ne matche le regex (`idx <= 0`), c'est **l'ordre CSV
  qui gagne** — l'image primaire Aosom reste vedette.
- **Source des images:** colonnes CSV `Image`, `Images`, `Image1..Image7`
  (`csv-fetcher.ts:145-173`, `collectImages()`), pas les colonnes `image1..7` de la DB
  (celles-ci ne servent qu'au snapshot/export).
- Envoi à Shopify: `merged.images.map((src) => ({ src }))` — `shopify-client.ts:161`;
  `images[0]` devient l'image vedette.

**Limite pratique:** la promotion repose sur des mots-clés dans l'URL Aosom
(`lifestyle/ambiance/room`). Beaucoup d'URLs Aosom ne contiennent pas ces mots → en
pratique, pour ces produits, la vedette = la 1re image CSV (souvent un fond blanc).
Pour une vraie priorité lifestyle, il faudrait une détection visuelle (ratio de pixels
non-blancs / scène), pas un regex d'URL.

---

## 2. Champs vidéo dans la source Aosom

**Oui — le CSV Aosom fournit une URL vidéo MP4 directe par produit, et on la stocke déjà.**

Chaîne complète:
- Colonne brute CSV `Video` — `src/types/aosom.ts:40`.
- Parse: `video: row.Video?.trim() || ""` — `csv-fetcher.ts:135`.
- Merge variantes: `video: primary.video` — `variant-merger.ts:118`.
- Colonne DB: `video TEXT` — `database.ts:61` (table `products`).

**Couverture réelle (Turso, lecture):** `2 210 / 11 126` produits ont une URL vidéo
non vide (~20 %). Pas besoin de scraper la page Aosom — l'URL MP4 est déjà dans la DB.

Exemples concrets (`SKU → URL`):
- `720-021` → `https://uspm.aosomcdn.com/videos/en/7/720-021/720-021-WEB.mp4`
- `100110-066GR` → `https://uspm.aosomcdn.com/videos/en/1/100110-066GR/100110-066GR-WEB.mp4`
- `84D-031V03SD` → `https://uspm.aosomcdn.com/videos/en/8/84D-031V03SD/84D-031V03SD-Outsunny-WEB.mp4`

**Caveat:** le chemin est `/videos/en/...` (versions anglaises). La plupart sont des
démos visuelles produit; si certaines ont du texte/voix EN, ça jure avec le marché FR.
À vérifier à l'usage avant attachement en masse.

---

## 3. Voie API Shopify pour attacher une vidéo + scopes

**La voie décrite est correcte** et c'est la bonne pour OS 2.0 / Admin API GraphQL:

1. `stagedUploadsCreate` (resource `VIDEO`) → renvoie une cible d'upload (URL + params).
2. PUT/POST du MP4 vers la cible stagée.
3. `productCreateMedia` avec `mediaContentType: VIDEO` et le `resourceUrl` stagé.
4. Polling de `Media.status` (via `product.media` / `node`) jusqu'à `READY`
   (Shopify transcode en asynchrone; statuts `UPLOADED → PROCESSING → READY`/`FAILED`).

**Scopes accordés au token actuel** (`/admin/oauth/access_scopes.json`, status 200):
```
read_content, read_locales, read_markets, read_online_store_navigation,
read_product_feeds, read_product_listings, read_products, read_script_tags,
read_themes, read_translations, write_content, write_markets,
write_online_store_navigation, write_product_feeds, write_product_listings,
write_products, write_script_tags, write_themes, write_translations
```

- `productCreateMedia` + `stagedUploadsCreate` (média produit) → exigent **`write_products`** ✅ présent.
- `write_themes` ✅ (édition thème), `write_translations` ✅ (metafields FR/EN).
- **Manque `read_orders`/`write_orders`** → pas d'accès aux commandes (voir §6).
  Pas de `write_files` non plus, mais le média **attaché à un produit** passe par
  `write_products`, donc OK pour la Phase 3 vidéos.

---

## 4. Template fiche produit + titre dupliqué + `##` littéral

**Template:** `templates/product.json` (thème `160059195497`), section `main`
type `main-product`. Le titre vient du bloc `title` (= **un seul H1**). La description
vient du bloc `description` type `description` (rend `product.description` = `body_html`).
Il n'y a **aucun bloc metafield rich-text** dans le template — la description est du
`body_html` HTML, pas un metafield.

**Ce que l'audit trouve réellement:**
- Sur les fiches **publiées** testées (`chemin-de-jardin…`, `arbre-a-chat…`):
  **H1 = 1, aucun `##`** dans le HTML rendu. Les fiches publiées sont **propres**.
- `body_html` du catalogue: **0 / 250** contiennent `##`; **0 / 8** EN metafields
  (`custom.body_html_en`) contiennent `##`. Le `##` littéral **n'est pas reproductible**
  dans le catalogue actuel → soit déjà corrigé, soit sur un produit isolé hors échantillon.
- **14 / 250** `body_html` commencent par un `<h2>` marketing généré par Claude
  (ex. `<h2>Transformez votre espace en oasis verdoyante</h2>` juste sous le H1 titre).
  **C'est le coupable le plus probable du "titre dupliqué" perçu**: H1 (titre produit)
  immédiatement suivi d'un gros H2 marketing → lu visuellement comme deux titres.

**Cause du `H1 + H2-lien` rapporté:** les imports sont créés en **draft**. L'URL publique
d'un produit draft **redirige vers la page d'accueil**. La home a `H1 = 2`
(logo vide + tagline « Meublez votre espace… ») et des **H2 qui sont des liens** vers les
collections (« Coups de cœur », « Meilleures offres »…). Si Mat a inspecté un produit non
publié via son URL produit, il voyait la home, pas la PDP — ce qui explique exactement
« H1 + H2-lien ».

**Pourquoi `##` (markdown) peut quand même apparaître:** Claude est prompté pour sortir du
**HTML direct** (`content-generator.ts:176`, `"descriptionFr": "<HTML…>"`), et la sortie
est stockée **sans conversion markdown** (`import-pipeline.ts:124` → `shopify-client.ts:134`
`body_html: content.descriptionFr`). Aucun `marked`/`remark`. Donc si le modèle émet un
`## Titre`, il fuite brut. Ça n'apparaît pas dans l'échantillon actuel, mais le risque est
structurel.

**Rich-text vs metafield:** la description PDP = `body_html` (HTML), **pas** un metafield
rich-text. Le `title_en`/`body_html_en` sont des metafields `custom.*` (EN), non rendus
sur la PDP FR (`shopify-client.ts:178-188`).

**Recommandations Phase suivante (hors scope lecture seule):**
1. Strip les headings de tête + normaliser le markdown résiduel dans le `body_html`
   avant push (`shopify-client.ts`): retirer un `<h2>`/`<h3>` initial qui répète/double
   le titre, et convertir/supprimer tout `#{1,6}` littéral.
2. Durcir le prompt Claude: « pas de titre ni de heading de niveau 1-2 en ouverture;
   commencer par un `<p>` ».
3. Confirmer le symptôme sur une fiche **publiée** (ou via l'aperçu admin du draft, pas
   l'URL publique) avant de chasser un bug fantôme.

---

## 5. Carrousels accueil — sélection des produits

Les carrousels sont des sections Shopify **`featured-collection`** standard
(`templates/index.json`), pilotées par des **collections**. Ils ne contiennent aucune
logique custom de sélection — ils affichent le contenu de la collection dans son ordre de tri.

| Carrousel (heading) | Section | Collection | Type | Tri | Produits (collection / affichés) |
|---|---|---|---|---|---|
| 🔥 Meilleures offres du moment | `featured_sale` | `rabais` | **Smart** | best-selling | 28 / 12 |
| Coups de cœur | `featured_collection2` | `coups-de-coeur` | **Smart** | best-selling | 234 / 16 |
| Mobilier extérieur populaire | `featured_collection1` | `mobiliers-exterieurs-et-jardins` | **Manuelle** | best-selling | 233 / 16 |
| Magasinez par catégorie | `collection_list` | 6 blocs `featured_collection` | — | — | — |

Règles smart:
- `rabais`: ANY de `variant_compare_at_price > 0` **OU** tag `sale` **OU** tag `rabais`.
- `coups-de-coeur`: ANY des tags `patio, chaise-table-patio, bbq-cuisson, jardinage-serre,
  loveseat, camping`.

**Filtrent-ils les épuisés? Non — et c'est sans objet.** Aucun toggle "hide sold out"
dans les sections, ET la boutique est **dropship avec `inventory_management: null`**
(`shopify-client.ts`) → les produits ne sont **jamais** "épuisés" côté Shopify, ils lisent
toujours "disponible". Le filtrage de stock n'a donc aucun effet ici.

**Note clé:** le tri `best-selling` s'appuie sur les **vraies données de commandes Shopify**.
Donc Shopify connaît les best-sellers réels — mais notre token API n'a pas `read_orders`
(voir §6), d'où le proxy local pour le classement de la Phase 3.

---

## 6. Top 30 vendeurs (pour la Phase 3 vidéos)

**Aucune donnée de vente dans notre DB.** Dropship → pas de table `orders`/`line_items`.
Le seul proxy disponible est la **vélocité de stock inférée**: les baisses de `qty`
rapportées par Aosom, loggées dans `price_history` (`change_type='stock_change'`,
`old_qty > new_qty`) — `database.ts:1314` `getTrendingProducts()`.

Données: `price_history` = 230 074 lignes, dont 198 931 `stock_change` → signal solide.

**Caveats:** (a) `units_moved` ≈ baisses de stock fournisseur, pas des ventes confirmées
(bruit possible: corrections fournisseur, restock+vente nets). (b) Le classement est par
**SKU** (variante), pas par produit groupé — plusieurs variantes couleur du même produit
apparaissent séparément (ex. `84A-009BK`/`84A-009`/`84A-009BN` = même balancelle).
(c) Alternative plus fiable = le tri Shopify `best-selling` (vraies commandes), mais
inaccessible en API sans `read_orders`.

**Top 30 par vélocité de stock inférée (fenêtre 30 j) — liste SKU pour Phase 3:**

| # | SKU | units_moved | jours actifs | prix | produit |
|---|---|---|---|---|---|
| 1 | `84A-009BK` | 613 | 28 | 128,99 | Patio Glider mesh |
| 2 | `84A-054V05BK` | 482 | 24 | 138,99 | Balancelle 3 places |
| 3 | `845-792V00YL` | 378 | 26 | 159,99 | Jardinière avec treillis |
| 4 | `84K-241V00LG` | 358 | 25 | 136,99 | Chaise zéro gravité (x2) |
| 5 | `845-039V01GY` | 352 | 26 | 54,99 | Bac jardin galvanisé |
| 6 | `845-652V00GY` | 346 | 27 | 49,99 | Bac surélevé pliable |
| 7 | `01-0893` | 326 | 28 | 147,99 | Balancelle double glider |
| 8 | `845-518GY` | 324 | 27 | 69,99 | Bac galvanisé 95" |
| 9 | `84H-209V00CG` | 310 | 26 | 111,99 | Bac surélevé galvanisé |
| 10 | `845-774V00BK` | 300 | 27 | 124,99 | Bac galvanisé acier |
| 11 | `84G-791V00BK` | 298 | 22 | 64,99 | Coffre terrasse 28 gal |
| 12 | `84A-009` | 296 | 26 | 128,99 | Patio Glider mesh |
| 13 | `84C-142V01CG` | 292 | 26 | 73,99 | Moustiquaire gazebo |
| 14 | `84A-009BN` | 290 | 27 | 126,99 | Patio Glider mesh |
| 15 | `845-335` | 289 | 25 | 49,99 | Agenouilloir/siège jardin |
| 16 | `84B-136BK` | 286 | 29 | 54,99 | Coussin balancelle |
| 17 | `844-610V00BK` | 285 | 27 | 185,99 | Écran d'intimité métal |
| 18 | `823-010V81` | 285 | 19 | 394,99 | Climatiseur portatif 10k BTU |
| 19 | `84B-136` | 283 | 26 | 63,99 | Coussins banc 3 places |
| 20 | `370-198BK` | 282 | 24 | 129,99 | Tricycle Qaba 4-en-1 |
| 21 | `823-002V80` | 280 | 13 | 372,99 | Climatiseur portatif 10k BTU |
| 22 | `84K-241V00CG` | 279 | 24 | 149,99 | Chaise zéro gravité (x2) |
| 23 | `867-034` | 274 | 27 | 44,99 | Table basse rotin PE |
| 24 | `845-774V00SR` | 272 | 23 | 119,99 | Bac galvanisé acier |
| 25 | `84C-226CG` | 269 | 27 | 94,99 | Rideaux gazebo 10x12 |
| 26 | `84A-054V05BN` | 260 | 24 | 146,99 | Balancelle 3 places |
| 27 | `D51-277V01` | 259 | 27 | 329,99 | Poulailler extérieur |
| 28 | `84B-146BU` | 259 | 25 | 62,99 | Chaise longue pliable |
| 29 | `824-024V80BK` | 259 | 27 | 79,99 | Ventilateur sur pied |
| 30 | `01-0902` | 257 | 26 | 55,99 | Base de parasol 26 lb |

**Pour la Phase 3:** dédupliquer par produit de base (regrouper les variantes couleur),
puis croiser avec le §2 — combien de ces SKU ont déjà une URL vidéo Aosom prête à
attacher. Patio/jardin domine (cohérent: audit en juin, été QC).

---

## Synthèse — rien de P0/P1

| Axe | Verdict |
|---|---|
| 1 Image vedette | Priorité lifestyle par regex d'URL, sinon ordre CSV. Pas de détection fond blanc |
| 2 Vidéos source | URL MP4 directe dans le CSV/DB; 2 210 produits couverts; pas de scraping requis |
| 3 API média | Voie confirmée; `write_products` présent; manque `read_orders` |
| 4 PDP titre/`##` | Fiches **publiées propres** (1 H1, pas de `##`); symptômes = aperçu d'un draft (redirige home) + `<h2>` marketing en tête de 14/250 descriptions |
| 5 Carrousels | `featured-collection` sur collections (rabais/coups-de-coeur/mobiliers), tri best-selling; pas de filtre épuisé (sans objet en dropship) |
| 6 Top vendeurs | Pas de données ventes; proxy vélocité de stock → top 30 SKU ci-dessus |

Aucun finding de sécurité ou de fiabilité P0/P1. Les pistes d'amélioration (strip
heading/markdown PDP, détection lifestyle réelle, dédup variantes) sont des chantiers
de Phase ultérieure, pas des urgences.
