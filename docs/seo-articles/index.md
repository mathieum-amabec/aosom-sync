# Articles SEO/AEO — lot 1 (DRY-RUN)

Lot de 10 articles FR générés via l'API Anthropic (`claude-sonnet-4-6`) à partir des
types de produits réels en base (Turso). **Statut : brouillon, non publié.** Rien n'a été
poussé vers Shopify. Approbation de Mat requise avant toute mise en ligne.

- **Marché :** Québec, français primaire — ton éditorial, sans survente.
- **Contraintes respectées :** 0 nom fournisseur, 0 image, « livraison gratuite » 0×, méta ≤ 155 car., FAQPage JSON-LD valide (6 Q/R/article), slugs sans accents.
- **Liens internes :** vérifiés contre la Shopify Admin API (26 collections réelles). 1 handle corrigé (`chaises-et-tables-de-patio` → `chaises-et-tables-de-patio-1`), 1 repointé (`gazébos et abris` → collection réelle « Gazébos, parasols et abris »). ⚠ 1 cible inexistante : **« Entrée et vestibule »** (article #5) — à créer sur Shopify ou repointer.

| # | Article | Catégorie | Intention | Méta (car.) |
|---|---------|-----------|-----------|-------------|
| 1 | [Parasol déporté ou parasol droit : lequel choisir pour votre terrasse?](parasol-deporte-ou-droit-terrasse.md) | Mobilier extérieur | Comparatif | 155 |
| 2 | [Comment entretenir vos meubles de patio en résine tressée tout l'été](entretien-meubles-patio-resine-tressee.md) | Mobilier extérieur | How-to | 135 |
| 3 | [Gazebo, pergola ou abri pop-up : quel abri choisir selon votre cour](gazebo-pergola-abri-pop-up-choisir.md) | Mobilier extérieur | Informationnel | 142 |
| 4 | [Sofa sectionnel ou causeuse : comment choisir selon votre salon](sofa-sectionnel-ou-causeuse-salon.md) | Meubles | Comparatif | 155 |
| 5 | [Comment organiser une petite entrée : 7 idées de rangement à chaussures](organiser-petite-entree-rangement-chaussures.md) | Meubles | How-to | 133 |
| 6 | [Îlot de cuisine sur roulettes : bon choix pour une petite cuisine?](ilot-cuisine-roulettes-petite-cuisine.md) | Meubles | Informationnel | 129 |
| 7 | [Comment choisir un arbre à chat selon la taille et l'âge de votre chat](choisir-arbre-a-chat-taille-age.md) | Animaux | How-to | 151 |
| 8 | [Poulailler ou clapier : bien choisir l'habitat extérieur de vos petits animaux](poulailler-ou-clapier-habitat-exterieur.md) | Animaux | Comparatif | 154 |
| 9 | [Voiture électrique pour enfant : âge, sécurité et autonomie expliqués](voiture-electrique-enfant-age-securite-autonomie.md) | Enfants | Informationnel | 148 |
| 10 | [Comment aménager une aire de jeu sécuritaire dans votre cour](amenager-aire-de-jeu-securitaire-cour.md) | Enfants | How-to | 135 |

**Répartition :** 4 catégories (Extérieur ×3, Meubles ×3, Animaux ×2, Enfants ×2) · 3 intentions (Informationnel ×3, Comparatif ×3, How-to ×4).

## Génération

```
node scripts/generate-seo-articles.mjs <1-10|N-M|all>   # ANTHROPIC_API_KEY requis
node scripts/fix-collection-handles.mjs                  # SHOPIFY_ACCESS_TOKEN requis (GET only)
```

## À trancher avant publication

1. **« Entrée et vestibule »** (#5) : collection absente de Shopify. Créer la collection, ou repointer le lien.
2. Validation éditoriale des 10 articles par Mat.
3. Pipeline de publication (création des articles de blogue Shopify) — étape non couverte par ce lot dry-run.
