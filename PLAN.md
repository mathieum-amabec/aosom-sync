# aosom-sync — Plan d'architecture complet
> Document de référence pour Claude Code / Antigravity (gstack)
> Lire intégralement avant d'écrire la moindre ligne de code.
> Respecter l'ordre de build. Ne pas anticiper les phases futures.

---

## Contexte projet

Application de gestion de catalogue dropshipping Aosom → Shopify Canada (marché bilingue FR/EN, accent Québec).

- **Store Shopify :** `27u5y2-kp.myshopify.com`
- **Feed Aosom :** `https://feed-us.aosomcdn.com/390/110_feed/0/0/5e/c4857d.csv` (TSV, mis à jour quotidiennement, ~10 000+ produits)
- **Pipeline existant :** `~/.gstack/projects/aosom-shopify/` — scraper, OAuth, générateur bilingue, variant merger (référence uniquement, ne pas modifier)
- **Projet actif :** `~/.gstack/projects/aosom-sync/`
- **Stack :** Next.js App Router, Tailwind CSS, SQLite (`better-sqlite3`), Node.js
- **Dev env :** WSL Ubuntu, `localhost:3000`
- **Déploiement futur :** Vercel (ne pas configurer avant que tout soit stable localement)

### Principes non négociables
- Local-first. Aucune dépendance cloud avant validation locale complète.
- Ne jamais toucher à Turso, Vercel, ou toute infrastructure externe sans instruction explicite.
- Chaque job est indépendant et testable isolément.
- Toutes les clés API, tokens et secrets passent par `.env.local` uniquement.
- Le code doit être lisible par un non-développeur dans ses effets — logs clairs, erreurs explicites.

---

## Architecture globale

```
aosom-sync/
├── src/
│   ├── lib/
│   │   ├── csv-fetcher.js         # Fetch + parse du TSV Aosom
│   │   ├── shopify-client.js      # Wrapper Admin API Shopify
│   │   ├── differ.js              # Moteur de diff CSV ↔ Shopify
│   │   ├── claude-client.js       # Wrapper Claude API (génération contenu)
│   │   ├── image-composer.js      # Génération images sociales (sharp)
│   │   └── facebook-client.js     # Wrapper Facebook Graph API
│   ├── jobs/
│   │   ├── job1-sync.js           # Sync quotidienne prix/stock
│   │   ├── job2-catalogue.js      # Browser catalogue Aosom complet
│   │   ├── job3-import.js         # Import produit → Shopify (bilingue)
│   │   └── job4-social.js         # Génération drafts Facebook
│   └── db/
│       └── schema.sql             # Schéma SQLite complet
├── app/                           # Next.js App Router
│   ├── layout.tsx
│   ├── page.tsx                   # Dashboard principal
│   ├── sync/page.tsx              # Job 1 — Sync
│   ├── catalogue/page.tsx         # Job 2 — Catalogue
│   ├── import/page.tsx            # Job 3 — Import
│   ├── social/page.tsx            # Job 4 — Social Media
│   ├── settings/page.tsx          # Paramètres globaux
│   └── api/
│       ├── sync/route.ts
│       ├── catalogue/route.ts
│       ├── import/route.ts
│       ├── social/route.ts
│       └── settings/route.ts
├── .env.local                     # Secrets (jamais committé)
├── .env.example                   # Template public des variables requises
└── PLAN.md                        # Ce fichier
```

---

## Schéma de base de données (SQLite)

```sql
-- Produits Aosom (snapshot du dernier CSV)
CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  name TEXT,
  price REAL,
  qty INTEGER,
  color TEXT,
  size TEXT,
  product_type TEXT,
  image1 TEXT,
  image2 TEXT,
  image3 TEXT,
  image4 TEXT,
  image5 TEXT,
  image6 TEXT,
  image7 TEXT,
  video TEXT,
  description TEXT,
  short_description TEXT,
  material TEXT,
  gtin TEXT,
  weight REAL,
  out_of_stock_expected TEXT,
  estimated_arrival TEXT,
  shopify_product_id TEXT,        -- NULL si pas encore importé
  shopify_variant_id TEXT,
  last_seen_at INTEGER,           -- timestamp Unix
  last_posted_at INTEGER,         -- dernier post Facebook
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

-- Historique des changements détectés par le differ
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,
  old_price REAL,
  new_price REAL,
  old_qty INTEGER,
  new_qty INTEGER,
  change_type TEXT,               -- 'price_drop' | 'price_increase' | 'stock_change' | 'new_product' | 'restock'
  detected_at INTEGER DEFAULT (strftime('%s','now')),
  applied_to_shopify INTEGER DEFAULT 0,
  FOREIGN KEY (sku) REFERENCES products(sku)
);

-- Drafts de posts Facebook
CREATE TABLE IF NOT EXISTS facebook_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,
  trigger_type TEXT NOT NULL,     -- 'new_product' | 'price_drop' | 'stock_highlight'
  language TEXT NOT NULL,         -- 'FR' | 'EN'
  post_text TEXT NOT NULL,
  image_path TEXT,                -- chemin local vers image composée
  image_url TEXT,                 -- URL image uploadée sur Facebook
  old_price REAL,                 -- pour affichage prix barré
  new_price REAL,
  status TEXT DEFAULT 'draft',    -- 'draft' | 'approved' | 'scheduled' | 'published' | 'rejected'
  scheduled_at INTEGER,           -- timestamp Unix de publication prévue
  published_at INTEGER,
  facebook_post_id TEXT,          -- ID retourné par Graph API après publication
  created_at INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY (sku) REFERENCES products(sku)
);

-- Paramètres configurables (clé-valeur)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);

-- Valeurs par défaut des paramètres
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('social_default_language', 'FR'),
  ('social_post_frequency', '1'),          -- posts par jour (stock highlight)
  ('social_preferred_hour', '13'),         -- heure de publication (13h00)
  ('social_price_drop_threshold', '10'),   -- % minimum pour déclencher un draft
  ('social_min_days_between_reposts', '30'),-- jours avant de reposter le même produit
  ('social_hashtags_fr', '#jardinage #patio #mobilierexterieur #canada'),
  ('social_hashtags_en', '#garden #patio #outdoorfurniture #canada'),
  ('social_include_price', 'true'),
  ('social_include_link', 'true'),
  ('social_tone', 'promotional'),          -- 'professional' | 'casual' | 'promotional'
  ('prompt_new_product_fr', 'Tu es un expert en marketing pour une boutique québécoise de mobilier extérieur. Rédige un post Facebook engageant pour ce nouveau produit : {product_name}. Prix : {price}$. Ton : enthousiaste et accessible. Maximum 150 mots. Termine avec les hashtags : {hashtags}'),
  ('prompt_new_product_en', 'You are a marketing expert for a Canadian outdoor furniture store. Write an engaging Facebook post for this new product: {product_name}. Price: {price}$. Tone: enthusiastic and approachable. Maximum 150 words. End with hashtags: {hashtags}'),
  ('prompt_price_drop_fr', 'Tu es un expert en marketing promotionnel québécois. Rédige un post Facebook pour annoncer une baisse de prix sur : {product_name}. Ancien prix : {old_price}$. Nouveau prix : {new_price}$. Mets en valeur les économies. Maximum 120 mots. Hashtags : {hashtags}'),
  ('prompt_price_drop_en', 'You are a Canadian promotional marketing expert. Write a Facebook post announcing a price drop on: {product_name}. Old price: {old_price}$. New price: {new_price}$. Highlight the savings. Maximum 120 words. Hashtags: {hashtags}'),
  ('prompt_highlight_fr', 'Tu es un expert en marketing pour une boutique québécoise de mobilier extérieur. Rédige un post Facebook pour mettre en valeur ce produit populaire de notre catalogue : {product_name}. Prix : {price}$. Stock disponible : {qty} unités. Maximum 130 mots. Hashtags : {hashtags}'),
  ('prompt_highlight_en', 'You are a marketing expert for a Canadian outdoor furniture store. Write a Facebook post highlighting this popular product from our catalogue: {product_name}. Price: {price}$. Stock: {qty} units available. Maximum 130 words. Hashtags: {hashtags}');
```

---

## Job 1 — Sync quotidienne (`job1-sync.js`)

**Responsabilité :** Fetch du CSV Aosom → diff contre l'état Shopify actuel → application automatique des changements de prix et stock → génération de drafts Facebook pour les baisses de prix significatives.

**Déclenchement :** Manuel (bouton UI) + cron interne Next.js (quotidien, heure configurable).

**Logique métier :**
1. Fetch et parse du TSV via `csv-fetcher.js`
2. Pull des produits Shopify existants via `shopify-client.js` (uniquement les SKUs déjà importés)
3. Match SKU-à-SKU → génération du diff via `differ.js`
4. **Auto-appliqué :** changements de prix, changements de stock, mise à jour images si URL modifiée
5. **Queued pour review :** nouveaux produits non encore importés
6. **Trigger Job 4 :** si baisse de prix ≥ seuil configuré → crée un draft Facebook automatiquement
7. Écriture dans `price_history` pour chaque changement détecté

**Output attendu dans l'UI :** résumé du sync (N prix mis à jour, N stocks changés, N drafts Facebook créés, N nouveaux produits détectés).

---

## Job 2 — Catalogue browser (`job2-catalogue.js`)

**Responsabilité :** Exposer le catalogue Aosom complet (10 000+ produits) de manière navigable, filtrée, triable.

**Déclenchement :** Navigation dans l'UI (pas de cron).

**Colonnes clés du TSV Aosom :**
```
SKU | Name | Price | Qty | color | size | Product_Type | Image1-7 |
description | short_description | Material | Gtin | Weight |
Out Of Stock Expected | Estimated Arrival Time
```

**Fonctionnalités UI :**
- Pagination (50 produits par page)
- Filtres : catégorie (`Product_Type`), fourchette de prix, stock disponible uniquement, couleur, taille
- Tri : meilleurs vendeurs (vélocité stock), prix croissant/décroissant, stock restant (faible en premier), baisse de prix %
- Indicateur visuel : "En boutique" (déjà sur Shopify) vs "Non importé"
- Sélection multiple → bouton "Importer la sélection" → déclenche Job 3

---

## Job 3 — Import pipeline (`job3-import.js`)

**Responsabilité :** Prendre un ou plusieurs SKUs sélectionnés → générer contenu bilingue FR/EN via Claude API → merger les variantes couleur → publier sur Shopify.

**Déclenchement :** Manuel uniquement (sélection depuis Job 2 ou depuis la queue de nouveaux produits détectés par Job 1).

**Logique de merge des variantes :**
- Même SKU de base + même taille + couleurs différentes → un seul produit Shopify avec variantes couleur
- Tailles différentes → produits séparés
- Référence : `~/.gstack/projects/aosom-shopify/` pour la logique existante

**Génération contenu bilingue :**
- Stripper le HTML de la description Aosom avant envoi à Claude
- Remplacer `[BRAND NAME]` par le vrai brand (Outsunny, HomCom, etc.)
- Générer titre FR + titre EN, description FR + description EN, meta description FR + meta EN
- Stocker les deux versions dans Shopify (market-based translations ou champs custom selon config store)

**Post-import :** Mettre à jour `shopify_product_id` et `shopify_variant_id` dans la table `products` → déclenche automatiquement un draft Facebook "Nouveau produit" via Job 4.

---

## Job 4 — Social Media / Facebook (`job4-social.js`)

**Responsabilité :** Générer des drafts de posts Facebook (texte + image composée) basés sur les événements du catalogue, les exposer dans l'UI pour approbation, et publier via Graph API.

### 4.1 — Triggers de génération automatique

| Trigger | Source | Condition |
|---|---|---|
| `new_product` | Job 3 post-import | Toujours |
| `price_drop` | Job 1 diff | Baisse ≥ seuil configuré (défaut 10%) |
| `stock_highlight` | Cron interne | 1x/jour, pioche un produit en boutique non posté depuis N jours |

### 4.2 — Pipeline de génération d'un draft

```
Trigger reçu (type + SKU + données)
        ↓
Charger le prompt correspondant depuis settings (clé configurable)
        ↓
Interpoler les variables ({product_name}, {price}, {old_price}, etc.)
        ↓
Appel Claude API → texte du post
        ↓
Appel image-composer.js → image composée (voir 4.3)
        ↓
INSERT dans facebook_drafts (status = 'draft')
        ↓
Visible dans l'onglet Social de l'UI
```

### 4.3 — Composition d'image (`image-composer.js`)

**Librairie :** `sharp` (Node.js natif, pas de dépendance graphique externe)

**Templates par type de trigger :**

**`new_product`**
```
[ Image produit Aosom (fond) — 1200x630px ]
[ Bandeau bas semi-transparent ]
[ Nom du produit — police bold ]
[ Prix en gros — couleur accent ]
[ Logo/nom du store coin bas droite ]
```

**`price_drop`**
```
[ Image produit Aosom (fond) — 1200x630px ]
[ Badge "PRIX RÉDUIT" / "PRICE DROP" coin haut gauche ]
[ Ancien prix barré — rouge ]
[ Nouveau prix — vert bold, plus grand ]
[ % d'économie calculé automatiquement ]
[ Logo/nom du store ]
```

**`stock_highlight`**
```
[ Image produit Aosom (fond) — 1200x630px ]
[ Bandeau "Disponible maintenant" / "Available now" ]
[ Nom du produit + prix ]
[ Logo/nom du store ]
```

**Paramètres configurables dans l'UI :**
- Couleur accent principale (hex)
- Couleur texte overlay
- Nom du store à afficher
- Opacité du bandeau (0–100)
- Position du logo (coins)

**Format de sortie :** JPEG 1200x630px (format optimal Facebook), stocké dans `/public/social-images/` avec nom `{sku}-{trigger_type}-{timestamp}.jpg`

### 4.4 — Interface UI (onglet Social)

**Vue Drafts :**
- Liste des drafts en attente avec aperçu image + texte
- Chips de statut colorées : Draft / Approuvé / Schedulé / Publié / Rejeté
- Par draft : boutons Approuver / Modifier texte / Changer image / Scheduler / Supprimer
- Sélection de la langue FR/EN par draft
- Date/heure de publication souhaitée (datetime picker)

**Vue Calendrier :**
- Vue calendrier des posts schedulés et publiés
- Visualisation de la cadence de publication

**Vue Historique :**
- Tous les posts publiés avec leur performance (likes, reach — via Graph API Insights si disponible)

### 4.5 — Publication Facebook Graph API (`facebook-client.js`)

**Endpoints utilisés :**
```
POST /{page-id}/photos       → upload image + caption (post avec image)
POST /{page-id}/feed         → post texte uniquement ou avec link
GET  /{page-id}/insights     → métriques de performance (optionnel phase 2)
```

**Gestion des tokens :**
- `FACEBOOK_PAGE_ACCESS_TOKEN` dans `.env.local`
- Long-lived token (ne expire pas) — obtenu une fois via Graph API Explorer
- Rotation à implémenter en phase 2 si nécessaire

**Scheduling natif Facebook :**
- Si `scheduled_at` est défini → `published=false` + `scheduled_publish_time` (timestamp Unix)
- Si publication immédiate → `published=true`

---

## Onglet Paramètres (`settings/page.tsx`)

Interface de configuration complète, aucune modification de code requise après setup.

### Sections :

**Facebook / Graph API**
- Page ID
- Page Access Token (masqué, champ password)
- Bouton "Tester la connexion"

**Workflow Social**
- Langue par défaut des posts (FR / EN / Alterner)
- Nombre de posts par jour (stock highlight)
- Heure de publication préférée
- Seuil de baisse de prix pour déclencher un draft (%)
- Délai minimum entre deux posts du même produit (jours)

**Contenu**
- Hashtags FR (textarea)
- Hashtags EN (textarea)
- Ton du post (dropdown : Promotionnel / Professionnel / Décontracté)
- Inclure le prix (toggle)
- Inclure le lien Shopify (toggle)

**Prompts Claude (éditables)**
- Un textarea par type de trigger × langue (6 prompts au total)
- Variables disponibles affichées sous chaque prompt : `{product_name}`, `{price}`, `{old_price}`, `{new_price}`, `{qty}`, `{hashtags}`, `{store_name}`
- Bouton "Tester ce prompt" avec aperçu du résultat généré

**Image Composer**
- Couleur accent (color picker)
- Couleur texte (color picker)
- Nom du store à afficher
- Opacité bandeau (slider)
- Position logo (radio buttons)
- Aperçu en temps réel du template

**Shopify**
- Store URL
- API Token (masqué)
- Bouton "Tester la connexion"

**Claude API**
- API Key (masqué)
- Modèle à utiliser (défaut : `claude-sonnet-4-20250514`)
- Bouton "Tester la connexion"

---

## Variables d'environnement requises (`.env.local`)

```env
# Shopify
SHOPIFY_STORE_URL=27u5y2-kp.myshopify.com
SHOPIFY_ACCESS_TOKEN=

# Claude API
ANTHROPIC_API_KEY=

# Facebook Graph API
FACEBOOK_PAGE_ID=
FACEBOOK_PAGE_ACCESS_TOKEN=

# Aosom Feed
AOSOM_FEED_URL=https://feed-us.aosomcdn.com/390/110_feed/0/0/5e/c4857d.csv

# App
NEXT_PUBLIC_STORE_NAME=
```

---

## Ordre de build — phases strictes

### Phase 1 — Fondation (ne pas avancer sans validation)
- [ ] Schéma SQLite complet (`schema.sql`) + initialisation au démarrage
- [ ] `csv-fetcher.js` — fetch + parse TSV Aosom, normalisation colonnes
- [ ] `differ.js` — logique de diff CSV ↔ DB locale
- [ ] `shopify-client.js` — wrapper Admin API (GET produits, PUT prix, PUT stock)
- [ ] `job1-sync.js` — sync complète avec logs
- [ ] API route `/api/sync` + page UI basique (bouton + résultats)
- [ ] **Validation : lancer un sync complet, vérifier les diffs dans la DB**

### Phase 2 — Catalogue & Import
- [ ] `job2-catalogue.js` — chargement paginé du TSV, filtres, tri
- [ ] Page UI catalogue avec filtres, tri, indicateur "En boutique"
- [ ] `claude-client.js` — wrapper génération contenu bilingue
- [ ] `job3-import.js` — import complet avec merge variantes + génération FR/EN
- [ ] API route `/api/import` + UI sélection/import
- [ ] **Validation : importer 3 produits test, vérifier sur Shopify**

### Phase 3 — Social Media (Job 4)
- [ ] `image-composer.js` — 3 templates avec sharp (new_product, price_drop, highlight)
- [ ] `job4-social.js` — moteur de génération drafts (3 triggers)
- [ ] `facebook-client.js` — publish + schedule via Graph API
- [ ] Page UI Social — drafts, approbation, scheduling
- [ ] Onglet Paramètres — tous les settings configurables dont prompts éditables
- [ ] **Validation : générer un draft de chaque type, composer l'image, publier un test sur Facebook**

### Phase 4 — Automatisation & Déploiement
- [ ] Cron interne Next.js pour Job 1 (quotidien) et stock highlight (quotidien)
- [ ] Notifications (email ou autre) sur événements importants
- [ ] Tests de charge (10 000 produits dans le catalogue)
- [ ] **Seulement alors : configuration Vercel + déploiement**

---

## Notes pour Claude Code / Antigravity

- Ce projet est développé dans WSL Ubuntu sous `/home/{user}/.gstack/projects/aosom-sync/`
- L'ancien projet de référence est dans `/home/{user}/.gstack/projects/aosom-shopify/` — lire en lecture seule pour la logique de merge variantes et le flow OAuth
- `better-sqlite3` est le seul ORM/driver DB autorisé — pas de Prisma, pas de Drizzle
- Pas de `useEffect` pour les fetches — utiliser les Server Components et Server Actions de Next.js App Router
- Toutes les API routes retournent du JSON avec une structure cohérente : `{ success: boolean, data?: any, error?: string }`
- Les erreurs doivent être catchées et loggées proprement — jamais de `console.error` orphelins
- Les logs de jobs doivent être structurés : `[JOB1][2026-04-05 13:00:00] Prix mis à jour: SKU-1234 399$ → 349$`
- Implémenter Phase 1 complètement et valider avant de toucher à Phase 2
