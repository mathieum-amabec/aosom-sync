# TODOS

## UI / UX

### Layout responsive mobile (priorité : HAUTE)
**Branche suggérée :** `feature/mobile-responsive`

**Problème actuel :**
L'app est inutilisable sur mobile. La sidebar navigation est toujours visible et occupe ~60% de l'écran. Le contenu principal est écrasé dans les 40% restants, rendant tous les onglets illisibles : tableaux tronqués, cartes de stats coupées, texte qui déborde, filtres empilés hors écran.

**Pages affectées (toutes) :**
- Dashboard : cartes sync/price drops/velocity empilées mais trop étroites, texte wrap excessif
- Catalogue : colonnes du tableau coupées, noms de produits invisibles, filtres/search/sort empilés verticalement sans espace
- Sync History : contenu comprimé, panels sync runs + change log inutilisables
- Import Pipeline : stats row (Total/Pending/Ready/Imported/Errors) coupée, cartes produits trop étroites
- Collections : fonctionnel mais étroit, bouton d'action (violet) coupé à droite
- Social Media : stats row tronquée (on voit juste les chiffres sans labels), drafts ne se chargent pas (0 total vs 11 sur desktop — possible bug lié au viewport), bouton Generate Highlight coupé
- Settings : le plus lisible mais les champs sont étroits

**Comportement souhaité :**

1. **Sidebar → hamburger menu sur mobile**
   - Breakpoint : 768px (md en Tailwind)
   - En dessous de 768px : sidebar cachée, remplacée par un header fixe avec logo "Aosom Sync" à gauche + icône hamburger (☰) à droite
   - Au clic sur hamburger : sidebar slide-in depuis la gauche en overlay (avec backdrop semi-transparent)
   - Au clic sur un lien OU sur le backdrop : sidebar se referme
   - Le contenu principal occupe 100% de la largeur

2. **Dashboard mobile**
   - Cartes sync status, price drops, velocity : full-width, empilées verticalement
   - Boutons Dry Run / Full Sync : full-width, empilés

3. **Catalogue mobile**
   - Filtres (search, category, sort, price range, in stock) : layout vertical full-width
   - Tableau produits : passer en vue "cards" au lieu d'un tableau — chaque produit = une card avec image, nom, prix, qty, catégorie
   - Pagination en bas, boutons prev/next full-width

4. **Social Media mobile**
   - Stats row (Total/Drafts/Approved/Scheduled/Published) : grille 3+2 ou scroll horizontal
   - Filtres (All/Draft/Approved...) : scroll horizontal
   - Chaque draft : card full-width, image à gauche (petite), texte à droite, boutons d'action empilés en dessous (pas à droite)
   - Bouton Generate Highlight : full-width en haut

5. **Import Pipeline mobile**
   - Stats row : grille 3+2 ou scroll horizontal
   - Cards produits : full-width, boutons empilés

6. **Settings mobile**
   - Sections empilées full-width, champs de formulaire full-width
   - Déjà presque OK, juste ajuster les marges

7. **Collections mobile**
   - Liste catégories full-width, bouton d'action visible (pas coupé)

**Contraintes techniques :**
- Utiliser UNIQUEMENT les classes Tailwind responsive (sm:, md:, lg:) — pas de CSS custom ni de media queries manuelles
- Le layout actuel desktop ne doit PAS changer — on ajoute du responsive, on ne casse rien
- Tester sur viewport 375px (iPhone SE) et 390px (iPhone 14/15) minimum
- La sidebar mobile doit gérer le lien actif (highlight) comme sur desktop

**Bug potentiel à investiguer :**
Sur mobile, la page Social Media affiche 0 Total / 0 Drafts alors que le desktop affiche 11 Total / 10 Drafts. Vérifier si c'est un problème de fetch lié au viewport ou un vrai bug de data.

**Validation :**
- Ouvrir chaque page sur un viewport 375px dans Chrome DevTools
- Confirmer que tout le contenu est lisible et accessible sans scroll horizontal
- Confirmer que la navigation hamburger fonctionne (ouvrir/fermer/navigation)
- Confirmer que le layout desktop (>768px) est inchangé

---

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
