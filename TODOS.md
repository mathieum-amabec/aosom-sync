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

---

## Social Media / Job 4

### Wire content_type into FacebookDraft interface (v0.1.16.0 follow-up)

**Priority:** P3 (deferred to creative session)
**Context:** `content_type` column was added to `facebook_drafts` in v0.1.16.0 but is not yet in the `FacebookDraft` TypeScript interface or `mapDraft()`. Wire it up when implementing generation logic so drafts can be tagged informative/entertaining/engagement.

---

### Timestamp type inconsistency: new tables vs facebook_drafts

**Priority:** P4 (low, maintenance debt)
**Context:** `content_templates` and `content_generation_log` use `TIMESTAMP DEFAULT CURRENT_TIMESTAMP` (SQLite text format), while `facebook_drafts.created_at` uses `INTEGER` (Unix epoch). Will need `CAST` workarounds if joining across tables. Fix when implementing generation log queries.

---

### Branded image composer pour publications sociales (priorité : moyenne-haute)
**Branche suggérée :** `feature/social-branded-images`

**Objectif :**
Générer automatiquement des images brandées professionnelles pour chaque draft social, avec un look cohérent reconnaissable dans le feed. Les abonnés doivent identifier la marque visuellement avant même de lire le texte.

**Stack technique :**
- `canvas` (npm package, canvas HTML5 côté serveur) pour le rendu texte, badges, overlays, gradients
- `sharp` (déjà dans le projet) pour le resize/crop de l'image produit source
- Aucune API externe (pas de Canva, pas de Cloudinary)
- Module : `src/lib/image-composer.js` (déjà planifié dans PLAN.md — à réécrire avec canvas)

**Templates à créer (1200x630px, format Facebook optimal) :**

1. **Nouveau produit (`new_product`)**
   - Image produit centrée/recadrée en fond (sharp resize to fill)
   - Bandeau bas avec gradient semi-transparent (couleur accent configurable)
   - Nom du produit en texte bold blanc (max 2 lignes, tronqué avec ...)
   - Prix en gros, couleur accent
   - Logo/nom du store en coin bas droite
   - Badge "NOUVEAU" / "NEW" en coin haut gauche (pastille colorée)

2. **Baisse de prix (`price_drop`)**
   - Image produit en fond
   - Badge "PRIX RÉDUIT" / "PRICE DROP" en coin haut gauche (rouge vif, incliné -5°)
   - Ancien prix barré en rouge (police moyenne)
   - Nouveau prix en vert bold, 2x plus gros que l'ancien
   - Pourcentage d'économie calculé automatiquement dans un cercle (ex: "-25%")
   - Logo/nom du store

3. **Stock highlight (`stock_highlight`)**
   - Image produit en fond
   - Bandeau "Disponible maintenant" / "Available now" en haut
   - Nom du produit + prix
   - Logo/nom du store

**Brand identity configurable (dans Settings UI) :**
- Couleur accent principale (hex) — utilisée pour badges, prix, bandeaux
- Couleur secondaire (hex) — texte sur fond accent
- Nom du store à afficher sur les images
- Font principale (choisir parmi 3-4 Google Fonts embarquées : Montserrat, Inter, Poppins, Roboto)
- Logo du store (upload image PNG transparent) — optionnel, fallback sur le nom texte
- Opacité du bandeau overlay (slider 0-100%)

**Intégration dans le pipeline existant :**
- Quand `job4-social.js` génère un draft → appeler image-composer avec le type de trigger + données produit
- L'image composée est stockée en base64 dans la DB (colonne `composed_image` dans facebook_drafts) — PAS dans le filesystem (Vercel read-only)
- L'aperçu dans la page Social Media utilise l'image composée, pas l'image Aosom brute
- Le bouton Edit permet de régénérer l'image avec des paramètres différents
- Au Publish, l'image composée est uploadée directement sur Facebook via Graph API

**Contraintes :**
- Le package `canvas` nécessite des dépendances système (cairo, pango, libjpeg) — documenter l'installation pour WSL ET vérifier la compatibilité Vercel (peut nécessiter @napi-rs/canvas comme alternative serverless-compatible)
- Tester avec des noms de produits longs (>80 caractères) — le texte doit wrap intelligemment ou tronquer
- Tester avec des images produits de proportions variées (carrées, paysage, portrait) — le crop doit toujours donner un bon résultat
- Les caractères français (accents, ç, œ) doivent s'afficher correctement dans les fonts

**Validation :**
- Générer un exemple de chaque template (new_product, price_drop, stock_highlight)
- Confirmer le rendu visuel : texte lisible, pas de pixelisation, badge bien positionné
- Confirmer que l'image composée s'affiche dans l'aperçu Social Media
- Confirmer que le publish envoie l'image composée (pas l'image brute)
- Tester avec 3 produits différents (noms courts/longs, prix variés, images variées)

---

## Completed

### Bug B — UX feedback post-publication
**Completed:** v0.1.19.0 (2026-05-02)
- Edit/Photos/Reject/Publish disabled when status='published'
- "· Publié le {date}" badge in draft card header (fr-CA locale)
- Delete on published draft shows confirmation dialog (warns FB post stays live)
- Publish panel auto-closes when draft transitions to published mid-session
- P3 backlog: investigate whether publishedAt can exist on non-published drafts (DB inconsistency?)

### Bug A — Scheduled publications ne fire pas
**Completed:** v0.1.15.0 (2026-04-25)
- Root cause: `/api/cron/social` only ran `stock_highlight`, no worker processed `scheduled` drafts
- Fix: new `processScheduledDrafts()` in `job4-social.ts` + `/api/cron/social-scheduled` cron route
- Atomic claim added in v0.1.15.1: `claimFacebookDraft()` uses `UPDATE WHERE status='scheduled'` (rowsAffected===1) to prevent double-publish across concurrent cron instances
- Drafts 279/283/291 confirmed published in prod

### Multi-photos par publication
**Completed:** v0.1.8.0 (2026-04-13)
- `pickRandomImages` picks 1-5 random images from product image1..image7 with Fisher-Yates shuffle
- New `image_urls` JSON column on `facebook_drafts`, idempotent migration + legacy backfill
- `publishWithImages` handles album posts: uploads each photo unpublished then `/feed` with native JSON `attached_media` array
- `/social` draft cards: hero + thumbnail row + N photos badge; Photos action opens inline remove/reorder editor
- Instagram stays single-photo (IG carousel logged as future TODO in social-publisher.ts)
- Tests: 38 → 48 (pickRandomImages shuffle/cap + FB Graph API payload shape locked in via fetch-mock)

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
