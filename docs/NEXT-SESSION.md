# Next session — 24 avril 2026

## OUVERTURE SESSION

> Reprise aosom-sync après diagnostic Turso complet.
> Commence par Étape A: bench READ Turso pour valider viabilité Option α.

---

## État prod au checkpoint (23 avril soir)

- Version prod: **0.1.12.0** (PR #26 mergée et déployée ce matin)
- Tests: 110/110 (main)
- sync_runs: 0 running (propre)
- Dernier Phase 1 completed via cron: 2026-04-20T06:25:21Z (Phase 1 timeout depuis)
- Products count: 10 426

### PR #26 validée en prod ✅

Draft #290 `stock_highlight` créé à **2026-04-23T00:22:25 UTC** — Vercel a ancré
le cron à l'heure du deploy (pas 13:53 cette fois, deploy fait à ~00:22 UTC).
Social cron timeout + retry fix confirmé en production réelle.

---

## Diagnostic Turso complet — 3 hypothèses éliminées

### Hypothèse 1 — WebSocket sequential (libsql://) ❌ ÉLIMINÉE

`https://` mode donne 8× speedup sur petits payloads mais pas sur 427KB.
Gain modeste car bottleneck pas le protocol.

### Hypothèse 2 — Payload size (description ~88%) ❌ PARTIELLEMENT ÉLIMINÉE

Fix appliqué (branche `fix/turso-http-mode`, commit `00f5606`):
- `refreshProducts()`: description/short_description exclus de INSERT/UPSERT
- Payload réduit: 427KB → 174KB (-59%) ✅ bon standalone fix
- **MAIS**: timing inchangé. 174KB → ~22s/batch, même rythme que 427KB.
  Le bottleneck n'est pas la taille du payload.

### Hypothèse 3 — Statement count (multi-row INSERT) ❌ ÉLIMINÉE

Bench `bench-multirow-insert.ts` (Stratégies A/B/C, 3 runs chacune):
- Strategy A: 100× individuels → médiane **33s**
- Strategy B: 1× multi-row via `db.execute()` → médiane **41s** (plus lent)
- Strategy C: 1× multi-row via `db.batch([stmt])` → médiane **42s** (plus lent)

**Conclusion définitive**: Turso exécute chaque row de VALUES séparément au
niveau SQLite. Multi-row INSERT n'aide pas. SQLite processing time ~220-330ms/row
est structurel.

### Root cause finale

**Turso write latency = ~200–330ms/row, quelle que soit la formulation SQL.**

Avec 10 426 produits × ~250ms = ~2600s. Aucune reformulation SQL ne résout ça.
Le seul levier est de réduire le **nombre de rows qu'on écrit**.

---

## Option α — Diff-before-upsert (prochaine session)

Au lieu d'UPSERT tous les 10 426 produits chaque nuit, on ne write que les lignes
qui ont réellement changé depuis le dernier sync.

### Plan

```
Phase 1 actuelle:
  fetchCSV (10 426 produits)
  → refreshProducts(tous) → 105 batches × ~30s = timeout

Phase 1 avec Option α:
  fetchCSV (10 426 produits)
  → SELECT lightweight DB (sku, price, qty, images...) ← ÉTAPE A à mesurer
  → diff CSV vs DB → trouver changed_rows (~50–500 typiquement)
  → refreshProducts(changed_only) → 1–5 batches → ~1–5s
```

### ÉTAPE A — Bench READ (à faire en premier)

Mesurer le temps du SELECT lightweight:

```sql
SELECT sku, price, qty, image1, image2, image3, image4, image5, image6, image7,
       video, material, gtin, weight, out_of_stock_expected, estimated_arrival
FROM products
```

Objectif: confirmer que la lecture de 10 426 rows sans description est rapide.

**Gate A**: 
- < 5s → Option α viahle, proceed
- 5–15s → viable si peu de rows changent (Phase 1 = 15s + batches)
- > 30s → SELECT aussi lent que les writes → option α perd son intérêt, 
  explorer Option β (passer à un autre provider)

Script à créer: `scripts/bench-read-products.ts`

```typescript
// Mesure:
// 1. SELECT * FROM products LIMIT 100 (warmup)
// 2. SELECT lightweight 10 426 rows × 3 runs → médiane
// 3. Taille payload retourné (JSON.stringify result)
// 4. Extrapolation Phase 1 = SELECT + 300 rows de writes estimés
```

### Implémentation Option α (après Gate A positif)

Dans `src/jobs/job1-sync.ts`, Phase 1:

```typescript
// 1. Fetch CSV → aosomProducts[]
// 2. SELECT lightweight DB → dbSnapshot Map<sku, {price, qty, images...}>
// 3. diff: filtrer les produits où ≥1 champ a changé
// 4. refreshProducts(changedOnly)  ← souvent 50–500 rows
```

Fichier clé: `src/lib/database.ts` — ajouter `getProductsLightweightSnapshot()`:
```typescript
export async function getProductsLightweightSnapshot(): Promise<Map<string, {...}>>
```

**Note**: les Zone 1/2/4 changes sur `fix/turso-http-mode` restent valides et
seront mergées avec ce fix. Le payload réduit (174KB) + diff-before-upsert =
double protection.

---

## Branche fix/turso-http-mode — état actuel

**Ne pas merger, ne pas ouvrir de PR.** Branche PAUSED sur commit `00f5606`.

Contenu:
- ✅ Zone 1 (database.ts): description/short_description exclus de INSERT
- ✅ Zone 2 (csv-fetcher.ts): fetchDescriptionsForImport() + cache 5min
- ✅ Zone 4 (diff-engine.ts): comparison description supprimée (fix bug destructif)
- ✅ 110/110 tests
- ❌ Phase 1 toujours >300s (payload réduit mais timing/row identique)

La branche sera rebasée sur main et complétée avec Option α avant merge.

---

## rebuildProductTypeCounts — bonus fix en attente

`database.ts:388-391` — 307 `db.execute()` séquentiels = ~77s additionnels en Phase 1.
Remplacer par `db.batch(allInserts)`. 5 lignes. À inclure dans le même PR qu'Option α.

---

## Autres items en attente (par priorité)

1. **Script force-push 74 produits driftés** — `scripts/force-push-shopify.ts`
   Exemple connu: 84G-720V00GY DB=$214.99 ≠ Shopify=$179.99

2. **content-generator.ts:100** — `generateProductContent()` a `max_tokens: 4000`
   sans timeout. Besoin 90s timeout. Branch: `fix/import-content-timeout` (à créer).

3. **Étape 2 plan sync**: migration + backfill variant IDs en DB

4. **Étape 3 plan sync**: refactor Phase 2 pour lire diffs depuis DB

5. **Meta App Review**: submission manuelle (business verif + screencast)

---

## Commandes pour reprendre

```bash
cd ~/.gstack/projects/aosom-sync
git checkout main
git pull origin main --ff-only
git status   # doit être clean
bun run test # sanity: 110/110 pass
cat docs/NEXT-SESSION.md
```

Pour lancer Étape A directement:
```bash
# Créer scripts/bench-read-products.ts (voir plan ci-dessus)
# npx tsx --env-file=.env.local scripts/bench-read-products.ts
```

---

## Commandes SQL prod utiles

```sql
-- Dernier sync run
SELECT id, started_at, completed_at, status, 
       total_products, duration_s
FROM sync_runs ORDER BY started_at DESC LIMIT 5;

-- Dernier draft social
SELECT id, trigger_type, status, datetime(created_at, 'unixepoch') 
FROM facebook_drafts ORDER BY id DESC LIMIT 3;
```
