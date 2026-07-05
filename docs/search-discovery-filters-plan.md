# Shopify Search & Discovery — Plan des filtres de collection

_Store: Ameublo Direct (`27u5y2-kp.myshopify.com`) · Admin API 2025-01 · 759 produits · rapport généré le 2026-07-05_

## Contexte

Les collections n'exposent aujourd'hui que **Disponibilité + Prix** — c'est le jeu de
filtres par défaut d'un thème OS 2.0 quand aucune configuration de filtre n'existe. Objectif :
enrichir ces filtres via **Shopify Search & Discovery** (app first-party gratuite).

---

## Ce qui est SCRIPTABLE vs MANUEL

| Étape | Scriptable ? | Détail |
|---|---|---|
| Lister les apps installées | ❌ **Non** | `appInstallations` (GraphQL) → `ACCESS_DENIED` pour une app custom ; `apps.json` (REST) → 404 (endpoint retiré). Vérification **manuelle** obligatoire dans l'admin. |
| Installer Search & Discovery | ❌ **Non** | App Store uniquement. Non scriptable. |
| Configurer les filtres S&D | ❌ **Non** | Se fait dans l'UI de l'app (Online Store → Search & Discovery → **Filters**). Aucune mutation Admin API publique/stable — le scope `write_discovery` de notre app custom n'expose pas de write des filtres storefront. |
| Activer les étoiles Judge.me dans Shopify | ❌ **Non** | Réglage dans l'app Judge.me (crée le metafield `reviews.rating`). |
| Auditer / nettoyer les valeurs `Couleur` | ✅ **Oui** | Bulk rename des valeurs d'option variant (write → dry-run + validation requise). |
| Créer une définition de metafield `matière` | ✅ **Oui** | `metafieldDefinitionCreate` + backfill (nouveau chantier data). |

---

## Inventaire des attributs filtrables (relevé API)

### ✅ Couleur — MEILLEUR candidat (couverture 86 %)
- Option variant **`Couleur`** présente sur **655 / 759** produits.
- **75 valeurs distinctes.** Les plus fréquentes sont propres et en français :
  `Noir` (208), `Gris` (120), `Blanc` (120), `Gris foncé` (86), `Crème`, `Bleu`, `Brun`,
  `Gris pâle`, `Rose`, `Rouge`, `Vert`…
- ⚠️ **Blocage qualité de données** : ~120 valeurs restent en anglais / non normalisées et
  **dupliquent** des valeurs FR — `Black`(30), `White`(21), `Brown`(12), `Grey`(11),
  `Yellow`(11) + longue traîne : `Rustic Brown`, `Wine Red`, `Multi Colour`, `Natural Wood`,
  `Cream White`, `Ash Grey`, `Walnut`, `Dark Walunt` (typo), `Noyer`, `Grey, Black`…
  Un filtre couleur brut afficherait **`Noir` ET `Black` comme deux facettes séparées** → mauvaise UX.
- **Deux voies pour corriger** (au choix, avant d'activer le filtre) :
  1. **Grouping dans S&D** (manuel, non destructif) — l'app permet de regrouper des valeurs
     d'option sous une étiquette unique + swatch (`Black`→`Noir`, etc.). Recommandé en 1er.
  2. **Normalisation des données** (scriptable) — bulk-rename des valeurs anglaises vers
     le référentiel FR de `COLOR_MAP` (`variant-merger.ts`). Dry-run + validation Mat requis.
     → **Dry-run livré : [`docs/couleur-normalization-dry-run.csv`](couleur-normalization-dry-run.csv)**
     (75 valeurs : **23 KEEP** / 990 variantes déjà propres, **27 RENAME** / 133 variantes sûres,
     **25 REVIEW** / 45 variantes à trancher). Aucune écriture tant que le CSV n'est pas validé.

### ✅ Taille — 2e option variant (couverture 86 %)
- Option **`Taille`** présente sur **654** produits. Filtre « Taille » viable, même logique de
  normalisation à vérifier (valeurs libres).

### ⏳ Note / Rating — bloqué tant que Judge.me n'écrit pas `reviews.rating`
- Judge.me **est installé** (metafields shop `judgeme.*` présents : `all_reviews_rating`,
  `shop_reviews_rating`…).
- Mais **0 produit** possède le metafield produit `reviews.rating` → l'option
  « Enable star rating in Shopify » de Judge.me **n'est pas activée**, et/ou aucun avis cumulé.
- S&D propose nativement un filtre **« Product rating »** dès que `reviews.rating` (type `rating`)
  existe sur les produits. → Activer côté Judge.me, laisser les avis se remplir, **puis** activer le filtre.

### ⚠️ Catégorie / Type de produit — filtrable mais valeurs EN
- `productType` = chemins taxonomie Google **en anglais** (`Patio & Garden > Lawn & Garden`,
  `Home Furnishings > Kitchen & Dining Furniture > Bar Stools`…). Hiérarchique et anglophone.
- Ne pas exposer tel quel à une clientèle FR. Préférer la structure de **collections** existante
  ou introduire un metafield catégorie FR avant d'en faire un filtre.

### ❌ Matière — aucune source propre
- **Aucun metafield `matière`.** Le signal existe seulement dans les **tags**, sale et bilingue :
  `acier`(45) / `steel`(33) / `steel frame`(33)… + tags EN/FR dupliqués (`patio`/`jardin`,
  `outdoor`/`extérieur`). Un filtre par tags exposerait des doublons et de l'anglais → à éviter.
- → **Nouveau chantier** : définir un metafield `custom.matiere` (liste) + backfill par règles/Claude,
  ensuite l'activer comme filtre metafield dans S&D.

### 🚫 À NE PAS exposer
- **Vendor** : uniforme (`Ameublo Direct` sur les 759) → inutile comme filtre. (Bon point : aucun
  nom fournisseur interdit dans le vendor.)
- **Tags** comme filtre : bilingues, contiennent `Aosom`/`aosom` (nom fournisseur interdit) — ne
  jamais transformer en facettes storefront.

---

## Plan de configuration S&D (dès l'app installée)

Ordre recommandé dans **Online Store → Search & Discovery → Filters** :

1. **Disponibilité** — garder (défaut).
2. **Prix** — garder (défaut).
3. **Couleur** (option `Couleur`) — activer **après** grouping des valeurs EN→FR + swatches.
   Impact : ~86 % du catalogue filtrable. **Filtre à plus fort ROI.**
4. **Taille** (option `Taille`) — activer après vérif des valeurs. ~86 % de couverture.
5. **Note produit** (`reviews.rating`) — activer **après** avoir activé les étoiles Judge.me
   dans Shopify et laissé les avis se cumuler.
6. _(Plus tard)_ **Matière** — après création + backfill du metafield `custom.matiere`.
7. _(Plus tard)_ **Catégorie FR** — après refonte de la taxonomie en français.

---

## Actions immédiates

- [ ] **MANUEL** — Admin → Apps : confirmer si « Search & Discovery » est installé (l'API ne
      peut pas le dire). Sinon l'installer depuis l'App Store (gratuit, first-party).
- [ ] **SCRIPTABLE** — Audit complet + dry-run de normalisation des 75 valeurs `Couleur`
      (mapping EN→FR via COLOR_MAP). Livrer un CSV pour validation avant tout write.
- [ ] **MANUEL** — Judge.me : activer « star rating in Shopify » pour peupler `reviews.rating`.
- [ ] **MANUEL (S&D)** — configurer les filtres dans l'ordre ci-dessus une fois l'app présente.
