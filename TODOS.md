# TODOS

## Import Pipeline

### Bulk Generate — Pousser tous les produits vers Shopify en batch

**Priority:** P1 (HIGH)
**Branch:** `feature/bulk-generate`
**Dépendances:** aucune

**Contexte:** La page /import affiche les produits Aosom avec un bouton "Generate" individuel par produit. Avec 10 000+ produits, c'est impossible de les faire un par un.

**Specs:**

1. **Bouton "Generate All"**
   - Un bouton en haut de la page /import, à côté des filtres
   - Texte : "Generate All" ou "Generate All Pending"
   - Style : bouton vert prominent, bien visible
   - Ne génère que les produits avec status "pending" (pas ceux déjà générés)

2. **Sélection partielle (nice to have)**
   - Checkboxes sur chaque produit (comme dans /catalog)
   - Bouton "Generate Selected" qui apparaît quand 1+ produits sont cochés
   - "Select All" checkbox en haut pour tout cocher

3. **Traitement en batch (critique pour la performance)**
   - NE PAS envoyer 10 000 requêtes Shopify en même temps
   - Traiter par batch de 10-25 produits à la fois
   - Respecter les rate limits de l'API Shopify (2 req/sec bucket)
   - File d'attente (queue) pour gérer les batches séquentiellement
   - Si un produit fail, continuer les autres (ne pas tout arrêter)

4. **Progress bar / feedback**
   - Barre de progression : "Generating... 142/10269 (1.4%)"
   - Compteurs live : succès, échecs, en attente
   - Log des erreurs pour les produits qui ont fail
   - Estimation du temps restant
   - Bouton "Stop" pour arrêter le processus en cours

5. **Résumé final**
   - Modal ou notification à la fin : "8,543 générés, 26 erreurs, 1,700 déjà existants"
   - Liste des erreurs avec le nom du produit et la raison
   - Bouton "Retry Failed" pour relancer seulement les erreurs

6. **Protection**
   - Confirmation avant de lancer : "Vous allez générer X produits sur Shopify. Continuer?"
   - Empêcher de lancer 2 bulk generate en même temps
   - Rate limiting pour pas se faire bloquer par Shopify

---

## Performance

### Cold start Vercel sur plan Hobby
**Priority:** P3 (LOW)
**Status:** Mitigé avec UptimeRobot (ping /api/health toutes les 5 min). Le plan Hobby ne supporte pas les crons fréquents. Upgrade au plan Pro résoudrait définitivement.

### Sync timeout sur Vercel
**Priority:** P2 (MEDIUM)
**Status:** Fixé — sync splitté en 2 phases (DB sync 6:00 UTC, Shopify push 6:10 UTC). Fonctionne dans les 300s du plan Hobby.

---

## Sécurité

### Rate limiting sur les endpoints Claude API
**Priority:** P2 (MEDIUM)
**Contexte:** Pas de rate limiting sur /api/import/generate. Un user malveillant pourrait spammer et générer des coûts Claude élevés. In-memory rate limiter resets sur cold starts (Upstash Redis recommandé).

---

## Social Media / Job 4

### Multi-photos par publication (priorité : moyenne)
**Branche suggérée :** `feature/social-multi-photos`

**Problème actuel :**
Chaque draft social généré automatiquement utilise toujours 1 seule image produit. Ça rend les publications répétitives et "bot-like" dans le feed Facebook/Instagram.

**Comportement souhaité :**
- À la génération d'un draft, choisir aléatoirement un nombre de photos entre 1 et 5
- Piocher les photos depuis les colonnes Image, Image1, Image2, Image3, Image4, Image5, Image6, Image7 du CSV Aosom (les images disponibles pour ce SKU)
- Ne jamais dépasser le nombre d'images réellement disponibles pour le produit (si un produit n'a que 3 images, max = 3)
- L'ordre des photos dans le carousel doit aussi être varié (pas toujours Image en premier — sauf si c'est la seule)
- Stocker les URLs des images sélectionnées dans la table facebook_drafts (champ JSON array `image_urls` au lieu d'un seul `image_url`)

**Impact sur le publish :**
- Si 1 image → POST /{page-id}/photos (comportement actuel)
- Si 2+ images → utiliser l'endpoint multi-photo de Facebook Graph API : créer chaque photo en unpublished (published=false), puis POST /{page-id}/feed avec attached_media[] pour créer un carousel/album
- Documenter l'endpoint Graph API exact à utiliser

**Impact sur l'UI :**
- L'aperçu du draft dans /social doit afficher toutes les images sélectionnées (mini carousel ou grille), pas juste la première
- Le bouton Edit doit permettre de retirer/réordonner les images avant publication

**Validation :**
- Générer 10 drafts et confirmer que le nombre de photos varie
- Publier un draft multi-photos sur une page test Facebook et confirmer le rendu carousel

---

## Completed

### Bulk Generate — Pousser tous les produits vers Shopify en batch
**Completed:** v0.1.4.0 (2026-04-11)

### Rate limiting sur les endpoints Claude API
**Completed:** v0.1.4.1 (2026-04-11)

### Layout responsive mobile
**Completed:** v0.1.6.0 (2026-04-12)
- Hamburger drawer sidebar below 768px with fixed header, slide-in, backdrop
- All dashboard pages (Catalogue, Social, Import, Collections, Settings, Sync, Dashboard) restack at 375px
- Catalogue swaps table for product cards on mobile, keeps table on desktop
- Single NotificationBell mount via `useIsDesktop` matchMedia hook (no more double-polling)
- Social Media "0 drafts on mobile" was not a real bug — drafts were present, just visually clipped by the broken layout

### Social Media v2 — Multi-brand FB + Instagram, bilingue, auto-post
**Completed:** v0.1.5.0 (2026-04-11)
- 3 channels live: Facebook Ameublo (FR), Facebook Furnish (EN), Instagram Ameublo (FR)
- Furnish Instagram waiting on account creation (env var flip activates it)
- Auto-post on price drop with threshold + daily limit + channel selection
- Per-channel retry from the UI

## Follow-ups / P3

### Settings UI for auto-post configuration
Currently `social_autopost_*` settings must be inserted via API or DB. Add a form on /settings with a toggle, min drop %, max/day, and channel checkboxes.

### Dual-brand test buttons on /settings
Today the "Test Facebook" button only tests Ameublo. Add a second button for Furnish and one for Instagram Ameublo.

### Instagram Furnish Direct
When the user creates the Instagram account, run the Graph API flow again to capture `INSTAGRAM_FURNISH_ACCOUNT_ID`, set the env var, redeploy — no code changes needed.
