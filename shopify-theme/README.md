# shopify-theme/ — artefacts thème (Projet #1 visibilité agentique)

Ces fichiers sont déployés sur le thème Shopify via l'**Asset API**, pas par le
build Next.js. Ils sont versionnés ici pour revue (PR) et reproductibilité.

**Cible :** thème `160213696617` du store `27u5y2-kp.myshopify.com`.
⚠️ Ce thème est actuellement **`role: main` (publié/live)** — décision confirmée
par Mat. Un upload d'asset prend effet **immédiatement**. Déployer seulement
après le checkpoint, puis vérifier, et garder le rollback prêt.

## Fichiers

| Fichier | Asset Shopify | Action |
|---|---|---|
| `templates/robots.txt.liquid` | `templates/robots.txt.liquid` | **CRÉE** (le thème n'en avait pas → servait le défaut Shopify) |
| `snippets/agentic-structured-data.liquid` | `snippets/agentic-structured-data.liquid` | **CRÉE** |
| (édition en place) | `sections/main-product.liquid` | **1 ligne** modifiée (voir ci-dessous) |

### Édition `sections/main-product.liquid`

Remplacer l'appel natif (≈ ligne 765) :

```liquid
    <script type="application/ld+json">
      {{ product | structured_data }}
    </script>
```

par :

```liquid
    {% comment %} Projet #1 : JSON-LD boutique (brand = boutique, pas le vendor/fournisseur) {% endcomment %}
    {% render 'agentic-structured-data', product: product %}
```

Raison : `product | structured_data` natif émet `brand = product.vendor` = « Aosom »
(fournisseur). Le snippet force la marque boutique et enrichit le balisage.

## Déploiement (après approbation)

Pour chaque asset : `PUT /admin/api/2025-01/themes/160213696617/assets.json`
avec `{ "asset": { "key": "...", "value": "<contenu>" } }`.

Ordre : 1) snippet, 2) main-product.liquid (édité), 3) robots.txt.liquid.

## Vérification post-déploiement

- `curl https://ameublodirect.ca/robots.txt` → confirmer les groupes `User-agent`
  des agents IA **avec** leurs `Disallow` transactionnels conservés.
- Google **Rich Results Test** sur une PDP → Product + FAQPage valides, `brand` =
  Ameublo Direct, aucune mention fournisseur.

## Rollback

- `robots.txt.liquid` : `DELETE` l'asset → Shopify ressert son `robots.txt` par
  défaut (état d'origine).
- `main-product.liquid` : ré-uploader la version d'origine (remettre
  `{{ product | structured_data }}`).
- `agentic-structured-data.liquid` : `DELETE` l'asset (inerte une fois la PDP revertie).
