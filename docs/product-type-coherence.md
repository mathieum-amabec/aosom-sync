# Cohérence des `product_type` & sous-catégories Extérieur — 2026-06-30

Suite à la refonte taxonomie du 2026-06-28 (`taxonomie-categories.md`), audit complet
des 737 produits Shopify pour vérifier que chaque `product_type` tombe dans la bonne
collection automatique.

## Constat

- Les exemples « climatiseur dans Meubles / classeur dans Électro » étaient **déjà
  corrigés** par la refonte du 28 : climatiseurs/ventilateurs sont en **Électro & Tech**,
  classeurs en **Bureau & Travail**, machines à glace en **Électro**. **0 conflit
  multi-parent.**
- Le vrai problème : **102 produits orphelins** (sur 737) dont le `product_type` était un
  **libellé libre** (`Gazebo`, `Greenhouse`, `Garden Bed`, `Patio Furniture`, `Outdoor
  Lighting`…) sans le préfixe taxonomie Google exigé par les règles `type contains`. Ils ne
  tombaient dans **aucune** collection parente → invisibles dans la navigation. Tous des
  produits **Extérieur & Jardin**, sauf 1 rampe d'escalier (→ Bricolage).

## Nouvelles collections créées (6)

| Handle | ID | Règles (`type contains`, disjonctif) |
|---|---|---|
| `gazebos-et-pergolas` | 475847852137 | Gazebo / Pergola / Pergolas / Wedding & Events Tents / Canopy |
| `jardin-eclairage` | 475847884905 | Patio & Garden > Outdoor Lighting |
| `jardin-decoration` | 475847917673 | Patio & Garden > Outdoor Décor |
| `piscines-et-spas` | 475847950441 | Patio & Garden > Pool & Spa (futurs imports) |
| `electro-chauffage` | 475847983209 | Electric Fireplace / Electric Tower Heater / Space Heater / Electric Heater |
| `enfants-vehicules` | 475848015977 | Ride-On / Powered Ride-Ons |

Toutes : `published: true`, `sort_order: best-selling`.

### Collisions écartées (réutilisation de l'existant)

13 sous-catégories demandées existaient déjà sous un **autre handle** (même `product_type`) ;
elles ont été **réutilisées** plutôt que dupliquées : `barbecue-et-cuisson`→`exterieur-bbq`,
`meubles-salle-a-manger`→`meubles-cuisine-salle-a-manger`, `decoration-interieure`→`meubles-decoration`,
`electro-cuisine`→`electro-petit-electromenager`, `animaux-petits-animaux`→`animaux-petits`,
`enfants-jouets-exterieurs`→`enfants-jeux-exterieur`, `enfants-mobilier`→`enfants-meubles`,
`sports-fitness`→`sport-exercice`, `sports-plein-air`→`exterieur-camping`, `sports-jeux`→`sport-salle-de-jeux`,
`bureau-mobilier`→`bureau-bureaux`, `electro-climatisation`/`electro-ventilation`→`electro-climatisation-ventilation`
(gardée combinée). `meubles-bureau` non créée (couverte par Bureau & Travail).

## Phase 2 — 102 `product_type` corrigés

| `product_type` corrigé | n | Sous-catégorie cible |
|---|---:|---|
| `Patio & Garden > Lawn & Garden` | 54 | `jardin-jardinage` |
| `Patio & Garden > Gazebos & Pergolas` | 21 | `gazebos-et-pergolas` |
| `Patio & Garden > Patio Furniture` | 19 | `patio-mobilier` |
| `Patio & Garden > Outdoor Décor` | 3 | `jardin-decoration` |
| `Patio & Garden > Outdoor Lighting` | 3 | `jardin-eclairage` |
| `Patio & Garden > Patio Shade` | 1 | `patio-ombrage` |
| `Home Improvement > Tools` | 1 | `bricolage-et-outils` |

Détail ligne-à-ligne : [`product-type-coherence-fixes.csv`](./product-type-coherence-fixes.csv).
Méthode : `PUT /products/{id}.json` champ `product_type` **uniquement**, 2 req/sec. **102/102 OK, 0 erreur.**

## Résultat vérifié

- **Orphelins : 102 → 0** (recalcul sur les 737 `product_type` re-fetchés).
- Comptes live : `exterieur-et-jardin` 261→**360**, `jardin-jardinage` 35→**89**,
  `patio-mobilier` 58→**77**, `gazebos-et-pergolas` **47**, `enfants-vehicules` **22**,
  `jardin-eclairage` **3**, `jardin-decoration` **3**, `bricolage-et-outils` 2→**3**.
- Les smart collections s'indexent de façon asynchrone : un compte à 0 (piscines, chauffage)
  = aucun produit importé pour l'instant, pas une règle cassée.

## Notes

- Aucune écriture sur un autre champ que `product_type`. Les 635 produits déjà bien classés
  n'ont pas été touchés.
- `exterieur-gazebos-tentes` (ancienne, règle `Wedding & Events Tents`, 23 prod.) coexiste
  avec `gazebos-et-pergolas` (47, surensemble) — laissée en place, non supprimée.
