# Taxonomie des catégories — ameublodirect.ca

_Généré le 2026-06-28. Basé sur le `product_type` (taxonomie Google) du catalogue réel._

## Résumé exécutif

- **41 smart collections** créées/mises à jour (39 créées, 2 mises à jour : `electro-et-tech`, `enfants`, + 1 correction de règle).
- Taxonomie à **2 niveaux** : 9 catégories parentes + ~32 sous-catégories, toutes pilotées par des règles `product_type` (auto-classement des futurs imports Aosom).
- **Catalogue Shopify actuel : 737 produits**, 186 `product_type` distincts. **86%** tombent dans une catégorie parente, **85%** dans une sous-catégorie.
- Conflits résolus : climatiseurs/ventilateurs sortis de Meubles → **Électro & Tech** ; « Mobilier extérieur » + « Chaises/tables patio » fusionnés sous **Extérieur & Jardin** (patio = sous-catégories non redondantes) ; sous-catégories **Animaux** (Chiens/Chats/Petits animaux/Oiseaux) et **Meubles** (Salon/Chambre/Cuisine/Rangement/…) créées.
- Thème **draft 160606093417** : tuiles catégories + mega-menu mis à jour. **Thème live 160584859753 jamais touché.**

## Modèle de règles

Le `product_type` Aosom suit la taxonomie Google hiérarchique (`Pet Supplies > Dogs > Pet Gates`). Chaque collection utilise une règle Shopify `type contains "<branche>"`, ce qui :
1. classe automatiquement tout futur produit importé portant ce préfixe ;
2. évite la maintenance manuelle des collections.

Meubles & Déco exclut les appareils via une règle conjonctive `contains "Home Furnishings" AND not_contains "Appliances"`.

## Taxonomie finale (parent → sous-catégories)

`P` = parente. Colonne **Shopify** = produits actuellement dans la collection ; le catalogue complet (11 378 lignes Aosom) en alimentera davantage à l’import.

| Catégorie | Handle | Shopify |
|---|---|---:|
| **Meubles & Déco** | `meubles-deco` | **168** |
| &nbsp;&nbsp;↳ Salon | `meubles-salon` | 55 |
| &nbsp;&nbsp;↳ Chambre | `meubles-chambre` | 26 |
| &nbsp;&nbsp;↳ Cuisine & Salle à manger | `meubles-cuisine-salle-a-manger` | 64 |
| &nbsp;&nbsp;↳ Rangement | `meubles-rangement` | 12 |
| &nbsp;&nbsp;↳ Salle de bain | `meubles-salle-de-bain` | 3 |
| &nbsp;&nbsp;↳ Décoration | `meubles-decoration` | 3 |
| &nbsp;&nbsp;↳ Déco saisonnière & Noël | `deco-saisonniere` | 5 |
| **Extérieur & Jardin** | `exterieur-et-jardin` | **261** |
| &nbsp;&nbsp;↳ Mobilier de patio | `patio-mobilier` | 58 |
| &nbsp;&nbsp;↳ Chaises longues & Transats | `patio-chaises-longues` | 22 |
| &nbsp;&nbsp;↳ Parasols & Ombrage | `patio-ombrage` | 36 |
| &nbsp;&nbsp;↳ Gazebos & Tentes | `exterieur-gazebos-tentes` | 23 |
| &nbsp;&nbsp;↳ Jardinage & Serres | `jardin-jardinage` | 35 |
| &nbsp;&nbsp;↳ BBQ & Grils | `exterieur-bbq` | 45 |
| &nbsp;&nbsp;↳ Foyers extérieurs | `exterieur-foyers` | 13 |
| &nbsp;&nbsp;↳ Balançoires & Hamacs | `patio-balancoires-hamacs` | 6 |
| &nbsp;&nbsp;↳ Camping & Plein air | `exterieur-camping` | 21 |
| **Animaux** | `animaux` | **65** |
| &nbsp;&nbsp;↳ Chiens | `animaux-chiens` | 35 |
| &nbsp;&nbsp;↳ Chats | `animaux-chats` | 28 |
| &nbsp;&nbsp;↳ Petits animaux | `animaux-petits` | 2 |
| &nbsp;&nbsp;↳ Oiseaux | `animaux-oiseaux` | 0 |
| **Enfants & Jouets** | `enfants` | **84** |
| &nbsp;&nbsp;↳ Jouets | `enfants-jouets` | 49 |
| &nbsp;&nbsp;↳ Jeux d’extérieur | `enfants-jeux-exterieur` | 25 |
| &nbsp;&nbsp;↳ Meubles pour enfants | `enfants-meubles` | 10 |
| **Bureau & Travail** | `bureau-et-travail` | **30** |
| &nbsp;&nbsp;↳ Chaises de bureau | `bureau-chaises` | 16 |
| &nbsp;&nbsp;↳ Bureaux & Postes de travail | `bureau-bureaux` | 7 |
| &nbsp;&nbsp;↳ Rangement de bureau | `bureau-rangement` | 7 |
| **Sports & Loisirs** | `sport-et-loisirs` | **5** |
| &nbsp;&nbsp;↳ Équipement d’exercice | `sport-exercice` | 0 |
| &nbsp;&nbsp;↳ Vélos & Trottinettes | `sport-velos-trottinettes` | 1 |
| &nbsp;&nbsp;↳ Sports d’équipe | `sport-equipe` | 1 |
| &nbsp;&nbsp;↳ Salle de jeux | `sport-salle-de-jeux` | 0 |
| **Électro & Tech** | `electro-et-tech` | **20** |
| &nbsp;&nbsp;↳ Climatisation & Ventilation | `electro-climatisation-ventilation` | 17 |
| &nbsp;&nbsp;↳ Petit électroménager | `electro-petit-electromenager` | 3 |
| **Bricolage & Outils** | `bricolage-et-outils` | **2** |
| **Santé & Beauté** | `sante-et-beaute` | **0** |

## Navigation & thème draft

- **Tuiles d’accueil** (`cat_tiles`, max 8) : Meubles & Déco, Extérieur & Jardin, Jardinage & Serres, Animaux, Enfants & Jouets, Sports & Loisirs, Électro & Tech, Rabais — chacune avec une image dédiée existante.
- **Mega-menu** : nouveau menu Shopify `taxonomie-categories` (9 parents + sous-catégories) ; le header du thème **draft** y pointe (réglage theme-scoped). Le menu principal du live (`preview-main-menu`) est inchangé.

## Orphelins & recommandations

Produits Shopify dans une racine parente mais sans sous-catégorie : **10**. Produits hors des 8 racines / sans type : **102**.

**Branches `product_type` sans sous-catégorie dédiée (catalogue complet) :**

| # produits (catalogue) | product_type |
|---:|---|
| 81 | Sports & Recreation > Lawn Games > Trampolines |
| 69 | Home Improvement > Tools > Tool Organizers |
| 45 | Health & Beauty > Salon Stools |
| 42 | Home Furnishings > Appliances > Small Kitchen Appliances |
| 29 | Home Improvement > Tools > Automotive |
| 20 | Health & Beauty > Health Care > Knee Walker & Wheelchair Ramps |
| 20 | Health & Beauty > Beauty Supplies > Jewellery Armoire & Jewellery Mirror Cabinets |
| 15 | Office Products > Office Supplies |
| 14 | Home Improvement > Tools |
| 13 | Home Improvement > Hardware > Door Hardware |
| 11 | Home Furnishings > Appliances > Car Coolers |
| 8 | Health & Beauty > Health Care > Portable Massage Tables |
| 8 | Health & Beauty > Beauty Supplies > Makeup Cases |
| 5 | Home Improvement > Building Supplies > Folding Hand Trucks |
| 5 | Home Furnishings > Appliances > Dryer Machines |

**Recommandations pour les futurs imports :**
- Ajouter des sous-catégories pour les branches volumineuses non couvertes : **Trampolines** (Sports > Lawn Games), **Outils & Organisateurs** (Home Improvement > Tools), **Tabourets de salon** (Health & Beauty > Salon Stools), **Refroidisseurs auto** (Appliances > Car Coolers).
- Les 102 produits hors-racines sont surtout Home Improvement / Health & Beauty / Office Supplies : déjà capturés par les parentes **Bricolage & Outils**, **Santé & Beauté**, **Bureau & Travail** au niveau racine.
- 15 produits Turso sans `product_type` → à taguer à l’import pour éviter qu’ils restent invisibles.

## Notes techniques

- **Turso ≠ Shopify** : la table Turso `products` est le flux Aosom complet (11 378) ; le store n’a que 737 produits importés. Les comptes « Shopify » ci-dessus sont la réalité du store ; le catalogue complet est le potentiel.
- **Espaces non-ASCII** : 12 `product_type` contiennent un espace insécable (U+00A0) dans leur segment feuille. Les règles matchant sur les segments parents (ASCII) ne sont pas affectées ; seule `electro-petit-electromenager` a été corrigée (condition `Appliances > Small`).
- Les smart collections Shopify s’indexent de façon asynchrone : un compte à 0 sur une sous-catégorie signifie « aucun produit importé pour l’instant », pas une règle cassée.
