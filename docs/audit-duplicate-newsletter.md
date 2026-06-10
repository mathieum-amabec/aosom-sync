# A5 — Bloc infolettre en double sur la page d'accueil

**Store:** 27u5y2-kp.myshopify.com · **Thème live:** `160059195497` (NON touché)
**Statut:** ✅ **APPLIQUÉ sur le thème PREVIEW `160213696617` (« Copie de Copie de Trade
v2 »).** `lc_newsletter` retiré de `templates/index.json` (section + entrée `order`), PUT 200.
Footer `newsletter_DPwWK7` conservé. Live intact. À publier en promouvant le preview après revue.

## Les deux blocs (tous deux des sections Shopify natives `newsletter`)

### Bloc A — corps de la home (RETIRÉ)
- `templates/index.json` → section `lc_newsletter`, titre **« Restez à l'affût »**
- Position d'origine: 15/18 (bas du corps). C'était le doublon.

### Bloc B — footer, toutes les pages (CONSERVÉ)
- `sections/footer-group.json` → section `newsletter_DPwWK7`, titre **« Abonnez-vous
  gratuitement »**. Site-wide → on le garde pour ne pas perdre l'inscription sur les autres pages.

## Klaviyo non affecté

Aucun formulaire Klaviyo injecté par JS sur le site (0 `klaviyo-form`, pas de `klaviyo.js`
onsite). Les deux `email_form` sont **natifs Shopify** → créent un client Shopify avec
consentement marketing → synchronisé vers Klaviyo (compte XAvTkS, double opt-in côté liste
Klaviyo). Retirer le bloc A natif ne change rien à la collecte : le footer continue d'alimenter
la même liste.

## Vérification (API Admin, autoritaire)

`scripts/verify-og-newsletter-preview.mjs` sur le preview `160213696617` :
- `lc_newsletter in sections: false | in order: false` ✅
- footer `newsletter_DPwWK7` toujours présent ✅

Note: le rendu public via `?preview_theme_id=` renvoie le thème **publié** (Shopify ignore le
param sans session staff), donc la confirmation visuelle se fait via **Online Store → Themes →
« Copie de Copie de Trade v2 » → Preview** (session admin authentifiée).
