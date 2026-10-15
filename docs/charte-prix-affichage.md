# Charte de prix et d'affichage des rabais — Ameublo Direct

Version du 2026-10-14. À faire valider par un avocat avant application (voir section 8).

## 1. Principe

Un prix barré dit au client « ce produit se vendait vraiment à ce prix ». On n'affiche un prix de référence que si on peut **prouver** cette phrase. Ce que font d'autres commerçants (y compris ameublementarabais.ca) ne compte pas comme preuve : leurs prix barrés sont en médiane 54 % au-dessus du prix Aosom, avec un rabais affiché presque uniforme (25 % à 35 %), ce qui ressemble à une règle et non à un historique.

Précédent à garder en tête : en 2017, Amazon Canada a payé 1 M$ de pénalité (plus 100 000 $ de frais) pour avoir repris des « prix de liste » de fournisseurs sans les vérifier.

## 2. Niveaux de preuve (un prix de référence, trois sources possibles)

| Niveau | Source du prix de référence | Conditions | Libellé affiché | État aujourd'hui |
|---|---|---|---|---|
| 1 | **Notre propre historique** (`price_history`) | Prix plus élevé d'au moins 10 %, tenu au moins 28 jours dans les 6 derniers mois, remplacé par une vraie baisse | « Prix habituel » | **En place** : 136 produits sur Shopify (328 au total) |
| 2 | **Prix de détail suggéré par le fabricant** (marques maison d'Aosom) | Confirmation écrite d'Aosom que c'est un vrai prix de détail suggéré, accord de l'afficher, mention du nom « Aosom » interdite | « Prix suggéré » | **Non disponible** : absent du flux, en attente de la réponse d'Aosom |
| 3 | Aucune preuve | — | **Aucun prix barré** | Tout le reste du catalogue |

Le niveau 2 ne s'applique jamais avec le mot « habituel » : on n'a pas vendu à ce prix.

## 3. Ce qu'on n'affiche jamais

- Un prix de référence copié d'un concurrent ou calculé par une règle (pourcentage fixe, valeur aléatoire).
- Un rabais « sur produits comparables » dont la comparaison n'est pas un vrai prix vérifié.
- « Liquidation », « on fait de la place », « jusqu'à épuisement » si ce n'est pas vrai.
- Un prix barré permanent : une promotion a une date de fin visible.
- Un rabais qui apparaît seulement parce qu'on a monté le prix juste avant (voir section 5).

## 4. Affichage sur la page (le thème le fait déjà)

Quand un produit a un prix de référence valide (`compare_at_price`), la page produit affiche déjà : le prix barré (« Prix habituel »), « Économisez X $ » et l'étiquette de rabais. Aucun changement de thème n'est requis pour les niveaux 1 et 2 ; il manque seulement les données. Les annonces catalogue Meta reprennent l'étiquette « Sale » à partir du même champ.

## 5. Promotions réelles (la voie pour avoir des rabais visibles à grande échelle)

1. Après la hausse de prix (règle de prix), **laisser les nouveaux prix stables au moins 28 jours**. Ce prix devient le vrai prix habituel.
2. Ensuite seulement, lancer des promotions **limitées dans le temps** (par exemple une semaine), avec date de fin affichée, sur une sélection de produits.
3. Profondeur maximale selon la marge. Avec la marge simulée de 19,4 % après la règle de prix (hypothèse : coût = prix B2B + livraison) :

| Rabais | Marge pendant la promotion |
|---|---|
| 5 % | 15,2 % |
| 10 % | 10,4 % |
| 15 % | 5,2 % |
| 20 % | -0,8 % (perte) |

   **Plafond recommandé : 10 à 15 %**, jamais sous 5 % de marge. Les rabais de 30 % à 35 % d'ameublementarabais ne sont pas atteignables sans perdre de l'argent sur chaque vente.
4. Aucun produit en promotion plus de la moitié du temps (sinon le prix de référence cesse d'être le prix habituel).
5. Les 136 produits qui ont déjà un vrai rabais (médiane 12 % ; 125 entre 10 et 20 %, 6 entre 20 et 30 %, 5 à 30 % ou plus) servent en priorité dans les annonces.

## 6. Journal de preuve

Pour chaque prix de référence affiché, on garde : SKU, prix de référence, dates pendant lesquelles il a été le prix affiché, source (historique ou confirmation écrite d'Aosom). La liste actuelle est dans `reference-prices-defensibles.csv`. Un audit mensuel retire tout prix barré dont la preuve a expiré (plus de 6 mois ou prix remonté).

## 7. Règles de prix liées (voir PR #606)

- Jamais sous le prix Aosom (entente avec Aosom).
- Un dollar sous le prix de l'ameublementarabais là où on le connaît, plafonné à +15 % sur Aosom.
- Sinon majoration par paliers : 7 % sous 200 $, 6 % de 200 à 400 $, 5 % de 400 à 800 $, 3 % au-dessus. Aucune majoration sur le patio et l'extérieur.
- Tous les prix finissent par .99.

## 8. Questions pour un avocat

1. Notre libellé « Prix habituel » (niveau 1, historique de 28 jours minimum) est-il suffisant, ou faut-il une période plus longue ?
2. Le « prix de détail suggéré » d'Aosom (niveau 2) peut-il être cité comme tel sans l'historique de ventes d'Aosom, et quelle confirmation écrite faut-il ?
3. La règle des promotions (prix stable 28 jours avant la promotion, pas plus de la moitié du temps en promotion) est-elle assez prudente pour le Québec ?
4. Quelle formulation est acceptable pour une comparaison avec un prix du marché (par exemple le prix d'un concurrent) ?
