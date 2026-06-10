# A3 — Image de partage social (og:image) de la page d'accueil

**Store:** 27u5y2-kp.myshopify.com · **Thème live:** `160059195497` (NE PAS éditer)
**Constat:** l'og:image actuel de la home est le **logo**, pas une image lifestyle.

## ✅ APPLIQUÉ sur le thème PREVIEW `160213696617` (Unsplash)

Image lifestyle Unsplash sélectionnée (patio résidentiel moderne avec plantes, paysage,
recadrée **1200×630** via les paramètres Unsplash, sans marque) :
`unsplash.com/photos/UQXMWJHusQs` (par Kristaps Ungurs). Ping de téléchargement Unsplash
déclenché (ToS). Uploadée comme asset `assets/og-image-social.jpg` (226 Ko, image/jpeg) sur
le preview, puis injectée dans `layout/theme.liquid` avant `</head>` :

```liquid
<meta property="og:image" content="{{ 'og-image-social.jpg' | asset_url }}">
```

**⚠️ Caveat (à revoir en preview):** Shopify injecte déjà une `og:image` (le logo) via
`{{ content_for_header }}`. Notre balise s'ajoute **après** → la page preview a **2 balises
og:image**. Les scrapers (Facebook/LinkedIn) prennent en général la **première** (donc le logo),
ce qui pourrait neutraliser l'override. La solution propre **sans doublon** reste le réglage
admin ci-dessous (Social sharing image), qui remplace la source à la racine. À valider au
**Facebook Sharing Debugger** sur l'URL de preview avant publication. Live `160059195497` non
touché.

---

## Diagnostic (read-only)

`scripts/audit-home-meta.mjs` sur le rendu live (`https://ameublodirect.ca/`) :

```
og:image       : .../cdn/shop/files/Logo_d286ae3f...png?v=...   (largeur 488 px)
og:image:width : 488
og:title       : Ameublo Direct | Meubles et mobiliers extérieurs
```

- **C'est le logo**, 488 px de large — sous la recommandation Facebook/Open Graph de **1200 × 630**.
- `config/settings_data.json` du thème **n'expose aucun réglage** share/social image.
- `layout/theme.liquid` **ne contient aucune balise `og:image`** — elle est injectée par
  Shopify via `content_for_header`, avec repli sur le logo quand aucune image sociale n'est
  définie.

## Peut-on le faire via l'API Admin ? Non.

L'og:image de la boutique est le réglage **Online Store → Preferences → « Image de partage
sur les réseaux sociaux »** (niveau boutique). Il **n'est pas exposé par l'API Admin REST/
GraphQL** (pas de champ `OnlineStorePreferences`), et ce **n'est pas un fichier de thème**.
Il ne peut donc pas être modifié par script.

Le seul chemin « code » serait d'injecter une balise `<meta property="og:image">` dans
`layout/theme.liquid` — mais :
1. Cela créerait un **doublon** (Shopify injecte déjà une og:image via `content_for_header`).
2. La consigne interdit d'éditer le thème live ; il faudrait un **thème preview**, or
   l'API Shopify **ne sait pas dupliquer** un thème (pas de mutation `themeDuplicate`).

→ **La bonne méthode est l'admin**, pas le code.

## Action recommandée (admin, ~2 min, login store-owner)

1. Préparer une image **1200 × 630** (paysage), JPG/PNG < ~5 Mo, montrant une **scène de
   décor** (patio aménagé, salon meublé) — pas un produit sur fond blanc, pas le logo seul.
   Idéalement avec un léger bandeau de marque + tagline « Livraison gratuite au Canada ».
2. **Online Store → Preferences** → section **Social sharing image** → téléverser l'image →
   **Save**.
3. Valider le rendu avec le **Facebook Sharing Debugger**
   (`https://developers.facebook.com/tools/debug/`) en collant `https://ameublodirect.ca/`
   puis **Scrape Again** (Facebook met l'ancienne image en cache).

## Choix de l'image lifestyle

Aucune image du catalogue n'a de mot-clé `lifestyle/ambiance/room` dans son URL (URLs Aosom
hashées), donc pas de sélection automatique fiable. Deux options concrètes :

- **Option A (rapide):** prendre une photo en scène d'un best-seller saisonnier et la
  recadrer en 1200 × 630. Candidat phare (top vélocité, été QC) :
  - Balancelle 3 places `84A-054V05BK` — images:
    `https://img-us.aosomcdn.com/100/product/2026/05/21/lkCff319e4a6c223e.jpg`
    (vérifier img2/img3 pour la prise en décor la plus vendeuse).
- **Option B (mieux, brandé):** générer un composite 1200 × 630 (photo décor + logo +
  tagline). Le repo a déjà `src/lib/image-composer.ts` (sharp) qui pourrait produire ce
  visuel; à câbler dans un petit script si on veut un og:image de marque réutilisable.

## Pourquoi pas de PR de code

Le changement effectif est un téléversement dans l'admin (réglage boutique), non scriptable
et hors thème. Ce document EST le livrable du chantier A3. Aucun fichier de thème live touché.
