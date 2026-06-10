# A4 — Méta-description de la page d'accueil

**Store:** 27u5y2-kp.myshopify.com · **Thème live:** `160059195497` (NE PAS éditer)

## Actuel (à remplacer)

```
Magasinez des meubles, décorations, mobiliers de patio et accessoires pour le jardin
de QUALITÉ à des PRIX ACCESSIBLES livrés GRATUITEMENT directement chez vous. Livraison
gratuite partout au Canada.
```

Problèmes : ~230 caractères (tronqué dans Google, idéal 140-160), **MAJUSCULES** qui
crient (QUALITÉ / PRIX ACCESSIBLES / GRATUITEMENT), et « Livraison gratuite » répété 2×.

## Deux variantes proposées (~145 caractères, ton naturel)

**Variante 1 — saisonnier / local (recommandée en ce moment):**
```
Aménagez votre patio et votre jardin pour l'été québécois : mobilier d'extérieur, BBQ,
déco et accessoires, livrés gratuitement partout au Canada.
```
(~146 car.) Colle à la saison (juin) et aux best-sellers réels (patio/jardin dominent les
ventes l'été, cf. `docs/audit-pdp-video.md` §6). À **réviser à l'automne** vers la V2.

**Variante 2 — catalogue / livraison (evergreen):**
```
Meubles, mobilier de patio, décoration et rangement à prix accessibles. Magasinez en
ligne et profitez de la livraison gratuite partout au Canada.
```
(~145 car.) Neutre toute l'année, sans entretien saisonnier.

## Recommandation

**V1 maintenant** (pic de saison patio + alignée sur ce qui se vend), avec rappel de
basculer sur **V2 à l'automne**. Si tu préfères « set & forget », prends directement **V2**.

## Application

**Online Store → Preferences** → section **Search engine listing / Homepage meta
description** → coller le texte → **Save**. (Ou via le bloc « Title and meta description »
de la home dans l'éditeur SEO.)

### Pas faisable via l'API Admin publique
La home rend `{{ page_description }}` (`layout/theme.liquid:26`), qui provient du réglage SEO
**Homepage meta description** au niveau boutique (Online Store → Preferences). Ce réglage
**n'est pas exposé par l'API Admin REST/GraphQL** et n'est pas un fichier de thème — il se
modifie uniquement dans l'admin. Ce document est donc le livrable du chantier A4 ; aucun
fichier de thème live touché.
