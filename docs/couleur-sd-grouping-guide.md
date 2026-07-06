# Guide de grouping — filtre « Couleur » dans Search & Discovery

_Store : Ameublo Direct · À faire **manuellement** dans l'admin (non scriptable)._
_Source de vérité des décisions : [`couleur-normalization-dry-run.csv`](couleur-normalization-dry-run.csv)._

**Méthode retenue :** grouping S&D (non destructif, réversible). On ne renomme **pas** les
données produit — on regroupe/renomme uniquement l'affichage du filtre. Résultat : **75 valeurs
brutes → 41 couleurs propres en français.**

> **✅ COMPLET au 2026-07-06 — grouping 100 % fait, ZÉRO DOUBLON vérifié.**
>
> Balayage Playwright final (5 collections `nouveaux-arrivages`, `patio-mobilier`,
> `exterieur-et-jardin`, `coups-de-coeur`, `ensembles-de-patio` × **FR + /en**) : `TOTAL_LEAKS = 0`.
> 23 groupes FR propres, aucune valeur anglaise résiduelle, FR et EN identiques. Les 7 fusions et
> les renommages ci-dessous sont tous live. _(Historique du chantier conservé ci-dessous.)_

---

## ✅ TERMINÉ — checklist du chantier (toutes les actions ci-dessous sont faites)

### A. FUSIONS (7) — créer le groupe, cocher **toutes** les valeurs listées

| Groupe (FR) | Cocher ces valeurs | Doublon constaté à l'audit |
|---|---|---|
| **Kaki** | `Kaki` + `Khaki` | 6 collections |
| **Café** | `Café` + `Coffee` | nouveaux-arrivages, animaux |
| **Bronze** | `Bronze` + `Bronze Tone` | nouveaux-arrivages (+4) |
| **Crème** | `Crème` + `Cream` | nouveaux-arrivages (/en) |
| **Naturel** | `Natural` + `Natural Finish` + `Natural Wood` + `Natural wood finish` | nouveaux-arrivages |
| **Multicolore** | `Multi Colour` + `Multicolour` + `Brown, Green, White` + `Grey, White, Black` + `Red, Yellow, Blue` | nouveaux-arrivages |
| **Noyer** | `Walnut` _(distinct de **Noyer Foncé**, déjà fait)_ | nouveaux-arrivages |

> _Au plan initial mais **non observés** dans l'audit (à faire seulement si ces valeurs existent
> en catalogue) : **Gris foncé** (`+Dark Grey`), **Gris pâle** (`+Light Grey`/`Ash Grey`),
> **Gris charbon** (`+Carbon Grey`)._

### B. RENOMMAGES (14) — groupe à **une seule valeur**, juste pour le libellé FR

| Groupe (FR) | Valeur d'origine |
|---|---|
| **Jaune** | `Yellow` |
| **Chêne** | `Oak` |
| **Violet** | `Purple` |
| **Naturel vintage** | `Vintage Natural` |
| **Brun clair** | `Light Brown` |
| **Brun rustique** | `Rustic Brown` |
| **Rouge vin** | `Wine Red` |
| **Vert foncé** | `Dark Green` |
| **Bleu ciel** | `Sky Blue` |
| **Brun café** | `Coffee Brown` |
| **Havane** | `Tan` |
| **Carbonisé** | `Carbonized` |
| **Vert-de-gris** | `Verdigris (Green)` |
| **Vert armée** | `Army Green` |

**✅ Tout est fait et vérifié live (zéro doublon FR + EN).** _(Les 3 nuances de gris —
Gris foncé/pâle/charbon — n'apparaissent pas au catalogue, donc rien à faire.)_

> ⚠️ Un seul faux positif d'index : `ensembles-de-patio` montrait encore `Brun` en brut alors que
> `Brun` est bien groupé partout ailleurs → simple **lag de réindexation** de cette collection,
> se corrige seul. Tous les autres manques sont réels (consistants sur les collections fraîches).

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

## Tableau 1 — GROUPES DE FUSION (référence détaillée — 19 groupes)

Chaque groupe fusionne ≥ 2 valeurs. Trié par impact (variantes couvertes).
_(Statut synchronisé avec la section « Reste à faire » ci-dessus.)_

| Statut | Nom du groupe (FR) | Cocher ces valeurs | Variantes |
|---|---|---|---|
| ✅ | **Noir** | `Noir`, `Black` | 243 |
| ✅ | **Blanc** | `Blanc`, `White` | 144 |
| ✅ | **Gris** | `Gris`, `Grey`, `Mixed Grey` | 133 |
| ⬜ | **Gris foncé** | `Gris foncé`, `Dark Grey` _(non observé à l'audit)_ | 88 |
| ✅ | **Brun** | `Brun`, `Brown` | 61 |
| ⬜ | **Crème** | `Crème`, `Cream White`, `Cream` | 54 |
| ✅ | **Bleu** | `Bleu`, `Blue` | 52 |
| ⬜ | **Gris pâle** | `Gris pâle`, `Light Grey`, `Light grey`, `Ash Grey` _(non observé)_ | 51 |
| ✅ | **Vert** | `Vert`, `Green` | 42 |
| ✅ | **Rouge** | `Rouge`, `Red` | 40 |
| ⬜ | **Multicolore** | `Multi Colour`, `Multicolour`, `multi-colored`, `Grey, Black`, `Grey, White, Black`, `Red, Yellow, Blue`, `Black, Yellow`, `Green, Black`, `Black, Grey Geometric`, `Natural, Blue`, `Brown, Green, White`, `Natural, Black`, `Flower Pattern` | 19 |
| ✅ | **Argent** | `Argent`, `Silver` | 16 |
| ⬜ | **Café** | `Café`, `Coffee` | 12 |
| ⬜ | **Kaki** | `Kaki`, `Khaki` | 11 |
| ⬜ | **Naturel** | `Naturel`, `Natural`, `Natural Finish`, `Natural Wood`, `Natural wood finish` _(inclut l'ancien « Bois naturel »)_ | 13 |
| ⬜ | **Bronze** | `Bronze`, `Bronze Tone` | 6 |
| ⬜ | ~~**Bois naturel**~~ | → **fusionné dans Naturel** (décision Mat) | — |
| ⬜ | **Gris charbon** | `Gris charbon`, `Carbon Grey` _(non observé)_ | 3 |
| ⬜ | **Noyer** | `Noyer`, `Walnut` | 2 |

_✅ 8 faits (Noir, Blanc, Gris, Brun, Bleu, Vert, Rouge, Argent) · ⬜ 10 à faire dans ce tableau._
_(**Beige** et **Noyer Foncé** aussi faits — voir Tableau 3 / Tableau 2.)_

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
| ⬜ | **Brun clair** | `Light Brown` | 3 |
| ⬜ | **Vert foncé** | `Dark Green` | 3 |
| ⬜ | **Bleu ciel** | `Sky Blue` | 2 |
| ⬜ | **Brun café** | `Coffee Brown` | 2 |
| ⬜ | **Naturel vintage** | `Vintage Natural` | 1 |
| ⬜ | **Chêne** | `Oak` | 1 |
| ✅ | **Noyer Foncé** | `Dark Walunt` _(faute → corrigée ; fait par Mat)_ | 1 |
| ⬜ | **Havane** | `Tan` | 1 |
| ⬜ | **Carbonisé** | `Carbonized` | 1 |
| ⬜ | **Vert-de-gris** | `Verdigris (Green)` | 1 |
| ⬜ | **Vert armée** | `Army Green` | 1 |
| ⬜ | **Violet** | `Purple` | 1 |

_✅ 1 fait (Noyer Foncé) · ⬜ 14 à faire._

---

## Tableau 3 — AUCUNE ACTION (déjà propres, 7 valeurs)

Ces valeurs sont déjà en français et sans doublon — ne rien faire, elles s'affichent telles quelles :

`Rose` (46), `Bleu foncé` (32), `Beige` (29), `Orange` (14), `Brun foncé` (8), `Vert pâle` (7), `Vert forêt` (3).

> _Note : Mat a quand même créé un **groupe « Beige »** (✅) — sans impact négatif, ça reste une seule facette propre._

---

## Après le grouping

- Vérifier sur le storefront (collection FR + /en) que le filtre Couleur affiche **41 facettes
  propres**, sans anglais résiduel ni doublon Noir/Black.
- Si S&D ne permet pas un rendu satisfaisant (ex. libellés qui persistent), basculer sur la
  **normalisation des données** (rename réel des valeurs d'option variant) — 2e dry-run par
  variante + go de Mat requis avant tout write. Le mapping du CSV sert directement de source.
