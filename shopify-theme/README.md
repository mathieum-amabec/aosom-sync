# shopify-theme/ — artefacts thème (Projet #1 visibilité agentique)

Ces fichiers sont déployés sur le thème Shopify via l'**Asset API**, pas par le
build Next.js. Ils sont versionnés ici pour revue (PR) et reproductibilité.

**Cible :** thème `160213696617` du store `27u5y2-kp.myshopify.com`.
⚠️ Ce thème est actuellement **`role: main` (publié/live)** — décision confirmée
par Mat. Un upload d'asset prend effet **immédiatement**.

## robots.txt — NON déployé (intentionnel)

> ❌ Pas de `robots.txt.liquid` ici. **Décision après test en prod (2026-06-16).**
>
> Le store sert déjà le **robots.txt par défaut de Shopify nouvelle génération**, qui
> est *déjà* optimisé pour les agents : `Allow: /` + publicité des endpoints agentiques
> (`agents.md`, `/.well-known/ucp`, endpoint UCP/MCP, `shop.app/SKILL.md`).
>
> Créer un `templates/robots.txt.liquid` (même via `robots.default_groups`) **remplace**
> ce défaut riche par le ruleset classique minimal et **supprime ces publicités UCP/MCP** —
> une **régression** pour la visibilité agentique. Testé en prod puis **rollback immédiat**
> (DELETE de l'asset → défaut Shopify restauré).
>
> **Conclusion :** ne rien overrider. Les agents IA listés sont déjà autorisés par le
> défaut, et le défaut advertise l'agentic storefront mieux que des blocs explicites.

## Fichiers déployés

| Fichier | Asset Shopify | Action | État |
|---|---|---|---|
| `snippets/agentic-structured-data.liquid` | `snippets/agentic-structured-data.liquid` | CRÉE | ✅ déployé |
| (édition en place) | `sections/main-product.liquid` | **1 ligne** swap | ✅ déployé |

### Édition `sections/main-product.liquid`

Le bloc natif :

```liquid
    <script type="application/ld+json">
      {{ product | structured_data }}
    </script>
```

est remplacé par :

```liquid
    {% comment %} Projet #1 : JSON-LD boutique (brand = boutique, pas le vendor/fournisseur) {% endcomment %}
    {% render "agentic-structured-data", product: product %}
```

Raison : `product | structured_data` natif émet `brand = product.vendor` = « Aosom »
(fournisseur). Le snippet force la marque boutique (`shop.name`) et enrichit le balisage.

## Déploiement (reproductible)

Pour chaque asset : `PUT /admin/api/2025-01/themes/160213696617/assets.json`
avec `{ "asset": { "key": "...", "value": "<contenu>" } }`.

1. `snippets/agentic-structured-data.liquid` (inerte tant que main-product ne l'appelle pas)
2. `sections/main-product.liquid` (édité)

## Vérification post-déploiement

- **PDP** : fetch `https://ameublodirect.ca/products/<handle>`, extraire les `application/ld+json` →
  Product valide, `brand` = Ameublo Direct (jamais le vendor), devise CAD, FAQPage présent.
  Confirmer aussi via Google **Rich Results Test**.

## Rollback

- `sections/main-product.liquid` : ré-uploader la version d'origine
  (sauvegardée lors du déploiement ; remet `{{ product | structured_data }}`).
- `snippets/agentic-structured-data.liquid` : `DELETE` l'asset (inerte une fois la PDP revertie).

## Résidu connu (hors scope)

Certains **noms de fichiers d'images** sur le CDN contiennent « Outsunny » (marque
maison du fournisseur). Ils apparaissent dans le tableau `image` du JSON-LD. Non
corrigeable au niveau thème (l'URL doit pointer vers l'asset réel) — relève du projet
de nettoyage de contenu (#4 / ré-upload d'images). Les champs sémantiques (`brand`,
`name`, `description`, `offers`) sont propres.
