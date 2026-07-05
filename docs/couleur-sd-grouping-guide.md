# Guide de grouping — filtre « Couleur » dans Search & Discovery

_Store : Ameublo Direct · À faire **manuellement** dans l'admin (non scriptable)._
_Source de vérité des décisions : [`couleur-normalization-dry-run.csv`](couleur-normalization-dry-run.csv)._

**Méthode retenue :** grouping S&D (non destructif, réversible). On ne renomme **pas** les
données produit — on regroupe/renomme uniquement l'affichage du filtre. Résultat : **75 valeurs
brutes → 41 couleurs propres en français.**

> **📊 Statut au 2026-07-05 (vérifié sur le storefront) : 7 / 34 faits.**
> ✅ Groupes créés et confirmés live : **Noir, Blanc, Gris, Bleu, Vert, Rouge, Argent**.
> ⬜ Restant : **12 fusions** (Tableau 1) + **15 renommages** (Tableau 2) = **27 actions**.
> Doublons/anglais encore visibles tant que ce n'est pas terminé (ex. `ensembles-de-patio`
> affiche `Brown` + `Brun` + `Light Brown` séparément).

---

## Où cliquer (une seule fois)

1. Admin Shopify → **Apps** → **Search & Discovery**.
2. Onglet **Filters**.
3. Si **Couleur** n'est pas déjà un filtre : **Add filter** → choisir l'option **Couleur** → Add.
4. Cliquer sur le filtre **Couleur** pour l'éditer → section **Grouping** (« Group filter values »).
5. Pour chaque ligne des tableaux ci-dessous : **Add group** → saisir le **nom du groupe** (le
   libellé FR) → cocher **toutes** les valeurs listées → **Save**.
6. _(Option polish)_ activer l'affichage **swatch** et assigner une pastille couleur par groupe.
7. Vérifier le rendu sur une collection du storefront (FR **et** /en).

> ⚠️ Dans un groupe de **fusion**, il faut cocher **aussi** la valeur FR canonique (ex. inclure
> « Noir » ET « Black » dans le groupe « Noir ») — sinon la valeur canonique resterait un facette
> séparée à côté du groupe.

---

## Tableau 1 — GROUPES DE FUSION (priorité ✱ — 19 groupes)

Chaque groupe fusionne ≥ 2 valeurs. Trié par impact (variantes couvertes).

| Statut | Nom du groupe (FR) | Cocher ces valeurs | Variantes |
|---|---|---|---|
| ✅ | **Noir** | `Noir`, `Black` | 243 |
| ✅ | **Blanc** | `Blanc`, `White` | 144 |
| ✅ | **Gris** | `Gris`, `Grey`, `Mixed Grey` | 133 |
| ⬜ | **Gris foncé** | `Gris foncé`, `Dark Grey` | 88 |
| ⬜ | **Brun** | `Brun`, `Brown` | 61 |
| ⬜ | **Crème** | `Crème`, `Cream White`, `Cream` | 54 |
| ✅ | **Bleu** | `Bleu`, `Blue` | 52 |
| ⬜ | **Gris pâle** | `Gris pâle`, `Light Grey`, `Light grey`, `Ash Grey` | 51 |
| ✅ | **Vert** | `Vert`, `Green` | 42 |
| ✅ | **Rouge** | `Rouge`, `Red` | 40 |
| ⬜ | **Multicolore** | `Multi Colour`, `Multicolour`, `multi-colored`, `Grey, Black`, `Grey, White, Black`, `Red, Yellow, Blue`, `Black, Yellow`, `Green, Black`, `Black, Grey Geometric`, `Natural, Blue`, `Brown, Green, White`, `Natural, Black`, `Flower Pattern` | 19 |
| ✅ | **Argent** | `Argent`, `Silver` | 16 |
| ⬜ | **Café** | `Café`, `Coffee` | 12 |
| ⬜ | **Kaki** | `Kaki`, `Khaki` | 11 |
| ⬜ | **Naturel** | `Naturel`, `Natural`, `Natural Finish` | 8 |
| ⬜ | **Bronze** | `Bronze`, `Bronze Tone` | 6 |
| ⬜ | **Bois naturel** | `Natural Wood`, `Natural wood finish` | 5 |
| ⬜ | **Gris charbon** | `Gris charbon`, `Carbon Grey` | 3 |
| ⬜ | **Noyer** | `Noyer`, `Walnut` | 2 |

_✅ 7 faits · ⬜ 12 à faire._

---

## Tableau 2 — RENOMMAGES SIMPLES (précision — 15 groupes, 1 valeur chacun)

Chaque entrée = un groupe à **une seule valeur**, juste pour afficher un libellé FR propre au
lieu de l'anglais/faute de frappe. Faible volume (≤ 11 variantes). _Optionnel si tu veux aller
vite : ces cas isolés seront de toute façon nettoyés proprement si on fait plus tard la
normalisation des données. Mais tant qu'à y être, ils enlèvent l'anglais du filtre._

| Statut | Nom du groupe (FR) | Valeur d'origine | Variantes |
|---|---|---|---|
| ⬜ | **Jaune** | `Yellow` | 11 |
| ⬜ | **Brun rustique** | `Rustic Brown` | 5 |
| ⬜ | **Rouge vin** | `Wine Red` | 5 |
| ⬜ | **Brun pâle** | `Light Brown` | 3 |
| ⬜ | **Vert foncé** | `Dark Green` | 3 |
| ⬜ | **Bleu ciel** | `Sky Blue` | 2 |
| ⬜ | **Brun café** | `Coffee Brown` | 2 |
| ⬜ | **Naturel vintage** | `Vintage Natural` | 1 |
| ⬜ | **Chêne** | `Oak` | 1 |
| ⬜ | **Noyer foncé** | `Dark Walunt` _(faute → corrigée)_ | 1 |
| ⬜ | **Havane** | `Tan` | 1 |
| ⬜ | **Carbonisé** | `Carbonized` | 1 |
| ⬜ | **Vert-de-gris** | `Verdigris (Green)` | 1 |
| ⬜ | **Vert armée** | `Army Green` | 1 |
| ⬜ | **Violet** | `Purple` | 1 |

_⬜ 0 fait · 15 à faire._

---

## Tableau 3 — AUCUNE ACTION (déjà propres, 7 valeurs)

Ces valeurs sont déjà en français et sans doublon — ne rien faire, elles s'affichent telles quelles :

`Rose` (46), `Bleu foncé` (32), `Beige` (29), `Orange` (14), `Brun foncé` (8), `Vert pâle` (7), `Vert forêt` (3).

---

## Après le grouping

- Vérifier sur le storefront (collection FR + /en) que le filtre Couleur affiche **41 facettes
  propres**, sans anglais résiduel ni doublon Noir/Black.
- Si S&D ne permet pas un rendu satisfaisant (ex. libellés qui persistent), basculer sur la
  **normalisation des données** (rename réel des valeurs d'option variant) — 2e dry-run par
  variante + go de Mat requis avant tout write. Le mapping du CSV sert directement de source.
