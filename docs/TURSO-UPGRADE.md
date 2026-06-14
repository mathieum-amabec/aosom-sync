# Turso — Diagnostic quota & plan d'upgrade

> Base : `libsql://aosom-sync-matmat-…` · Catalogue ≈ 11 126 lignes `products` (dont ~966 importées).
> Rédigé le 2026-06-14 (diagnostic P0 « plus capable de se connecter »).

## 1. Limites des plans Turso (juin 2026)

| Plan | Prix/mois | Storage | Row reads/mois | Row writes/mois | Overage |
|------|-----------|---------|----------------|-----------------|---------|
| **Free** | 0 $ | 5 GB | **500 M** | 10 M | — (bloqué au dépassement) |
| Developer | 4,99 $ | 5 GB+ | + élevé | — | métré |
| **Scaler** | 24,92 $ | 24 GB | **100 G** | 100 M | 0,80 $ / G reads · 0,80 $ / M writes · 0,50 $ / GB |
| Pro | 416,58 $ | — | — | — | métré |

Free = **~16,6 M reads/jour**. Au dépassement, Turso **bloque les requêtes** → l'app reçoit
des erreurs sur *toutes* les requêtes, y compris l'auth (voir §3).

## 2. Pourquoi on dépasse (classé par coût)

### 🔴 #1 — `getCatalogStats()` compteur « Avec rabais » (sous-requête corrélée)
`src/lib/database.ts:896` + `src/lib/catalog-filters.ts:21` (`PRODUCT_HAS_DISCOUNT_SQL`).

```sql
SELECT COUNT(*) FROM products
WHERE EXISTS ( SELECT 1 FROM (
  SELECT old_price, ROW_NUMBER() OVER (PARTITION BY sku ORDER BY detected_at DESC, id DESC) rn
  FROM price_history WHERE sku = products.sku AND change_type IN ('price_drop','price_increase') ...
) WHERE rn = 1 AND old_price > products.price )
```

Le `EXISTS` corrélé est **réévalué pour chacune des 11 126 lignes** ; chaque évaluation scanne
la tranche `price_history` du SKU. Reads par appel ≈ `11 126 + Σ price_history`. Si `price_history`
fait quelques centaines de milliers de lignes (elle grossit à chaque sync), **un seul chargement
de la page Catalogue = plusieurs centaines de milliers, voire millions, de rows read**.

Aggravant : la route `GET /api/catalog/stats` **n'a aucun `Cache-Control`** (le commentaire la
qualifie à tort de « cheap ») et la page la rappelle à chaque montage. La même page appelle aussi
`getProducts` (COUNT(*) + listing) → 4-5 scans/visite.

### 🟠 #2 — `price_history` non bornée
Aucune rétention. Chaque sync insère des `stock_change`/`price_drop`. La table grossit
indéfiniment → amplifie #1 **et** consomme du storage.

### 🟡 #3 — Scans complets `products` (bornés, peu fréquents)
- `getProductsSnapshot()` `database.ts:679` — `SELECT 23 cols FROM products` (~11k). Appelé 2× par
  run de sync, 2 runs/jour (06:00 + 06:30) → 4 scans/jour.
- `getAllProductsAsAosom()` `database.ts:2250` — cron `sync-shopify` à 8h ×3 → 3 scans/jour.
- `getEligibleHighlightProduct()` `database.ts:2216` — cron `social` 1×/jour.

→ Quelques dizaines de milliers de reads/jour. **Non critique.**

### 🟡 #4 — `initSchema()` rejoué à chaque cold start
`database.ts:46-522`. Memoïsé *par process* seulement ; chaque cold start serverless rejoue :
batch de ~40 `CREATE … IF NOT EXISTS`, ~6 `PRAGMA table_info`, `INSERT OR IGNORE` de 26 settings,
**batch `CLICKBAIT_TEMPLATES` à chaque cold start** (`database.ts:494-511`), `seedHooksIfEmpty()`.
Avec `social-scheduled` toutes les 15 min (96×/jour) + csv-precache + dashboard SSR → des centaines
de cold starts/jour qui rejouent ces writes. Surtout des **writes** (quota plus serré : 10 M).

### Ce qui N'EST PAS en cause
- **Feeds Google/Meta/Pinterest** : `getFeedItems()` lit **Shopify**, pas Turso
  (`src/lib/feeds/source.ts`). + CDN 24h (`s-maxage=86400`). L'hypothèse « feeds lisent Turso à
  chaque requête » est **fausse**.
- **Middleware / validation de session** : `proxy.ts` valide le cookie par HMAC, **zéro requête DB**
  par requête. Seul le **POST /api/auth (login)** touche Turso.

## 3. Le lien auth ↔ Turso (cause du « je ne peux plus me connecter »)

`POST /api/auth` → `getUserByUsername()` (`database.ts:1249`) → `ensureSchema()` → Turso.
Ligne `src/app/api/auth/route.ts:89` **non protégée** par try/catch.

```
Turso bloqué (quota) → getUserByUsername() throw → login = 500 → connexion impossible
```

Les sessions *existantes* restent valides (HMAC, pas de DB), mais toute **nouvelle connexion**
échoue tant que Turso est bloqué. C'est cohérent avec le symptôme P0.

> ⚠️ Vérifier le **dashboard Turso** (Usage) pour la cause exacte : `reads` épuisés vs `storage`
> plein vs base suspendue. Le `TURSO_AUTH_TOKEN` du `.env.local` est un token *de base*, pas un
> token *Platform API* — il ne permet pas de lire l'usage via API ; passer par le dashboard ou
> `turso db inspect` (CLI non installé sur ce poste).

## 4. Recommandation de plan

- **Court terme (débloquer maintenant)** : upgrade **Scaler (24,92 $/mo)** — 100 G reads,
  100 M writes, 24 GB. Lève immédiatement le blocage et donne 200× la marge de reads.
- **Si on applique les optimisations §5** : le Free (500 M reads) redevient probablement suffisant
  pour ce volume (~11k produits, 2 utilisateurs). Scaler reste l'assurance contre la croissance de
  `price_history` et les pics de navigation.

**Décision suggérée : Scaler maintenant pour débloquer, + optimisations §5, puis réévaluer le
retour au Free après 1 mois de métriques.**

## 5. Optimisations (par impact / effort)

| # | Action | Fichier | Impact reads | Effort |
|---|--------|---------|--------------|--------|
| 1 | **Cacher `/api/catalog/stats`** (`unstable_cache` ou `Cache-Control: s-maxage=600`) — les counts ne changent qu'au sync | `catalog/stats/route.ts` | 🔴 énorme | XS |
| 2 | **Précalculer le compteur rabais** comme `product_type_counts` (table rebâtie au sync) au lieu du `EXISTS` corrélé live | `database.ts` `rebuild*`, `getCatalogStats` | 🔴 énorme | M |
| 3 | **Rétention `price_history`** (ex. purge > 180 j, ou garder N derniers/SKU) au sync | `job1-sync.ts` | 🟠 reads + storage | S |
| 4 | **Découpler l'auth de Turso (P0)** : login admin de secours qui vérifie `AUTH_PASSWORD` sans `getUserByUsername` quand la DB est indisponible | `api/auth/route.ts`, `lib/auth.ts` | — (résilience) | S |
| 5 | **Alléger `initSchema` au cold start** : garder le seed CLICKBAIT/settings derrière un flag `settings` (comme `tutoiement_v1_migrated`) | `database.ts:46-520` | 🟡 writes | S |
| 6 | Réduire `social-scheduled` 15 min → 30/60 min | `vercel.json` | 🟡 faible | XS |

### Détail #1 (le plus rentable, le plus simple)
La route n'a pas de cache ; ajouter sur la réponse :
`headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=300" }`
(ou envelopper `getCatalogStats` dans `unstable_cache(..., { revalidate: 600 })`). Les trois
COUNT(*) — dont le coûteux compteur rabais — ne s'exécutent alors qu'≈ toutes les 10 min au lieu
d'à chaque montage de page.

### Détail #2 (suppression définitive du point chaud)
Maintenir un compteur `with_discount` (et idéalement une colonne `products.has_discount` posée au
sync) pour remplacer le `EXISTS` corrélé par un `COUNT(*) WHERE has_discount = 1` (scan simple,
indexable). Cohérent avec le pattern `product_type_counts` déjà en place.

## 6. Plan d'action P0 → P2

1. **P0 (aujourd'hui)** : upgrade Scaler → débloque login + catalogue.
2. **P0** : appliquer #4 (login de secours indépendant de Turso) pour ne plus jamais être enfermé
   dehors par un incident DB.
3. **P1 (cette semaine)** : #1 (cache stats) + #3 (rétention price_history).
4. **P2** : #2 (précalcul rabais) + #5 (cold-start) → viser le retour au Free.

## 7. Variable `AUTH_PASSWORD` (login de secours #4, PR #167)

Le login admin de secours (§5 #4) vérifie la variable d'environnement **`AUTH_PASSWORD`**
directement, sans passer par `getUserByUsername` (donc sans Turso). C'est le filet qui
garantit l'accès au dashboard même quand la DB est indisponible (incident Turso, quota
dépassé, cold start qui échoue).

**À configurer dans les trois endroits :**

| Endroit | Statut | Note |
|---------|--------|------|
| `.env.local` (dev local) | ✅ présent | non commité (gitignored) — valeur réelle locale |
| `.env.example` | ✅ placeholder `AUTH_PASSWORD=` | gabarit pour les nouveaux clones |
| **Vercel → Settings → Environment Variables** | ⚠️ **À AJOUTER PAR MAT** | sinon le fallback ne marche pas en prod |

> **Action Mat :** ajouter `AUTH_PASSWORD` dans les variables d'environnement Vercel
> (environnements Production + Preview) avec la même valeur que `.env.local`, puis
> redéployer. Sans cette variable en prod, le login de secours échoue silencieusement
> et un incident Turso peut t'enfermer dehors — c'est exactement le scénario que le
> P0 #4 visait à éliminer.
