# Next session — après 24 avril 2026

---
## SESSION 09 mai — DOUBLE SHIP DAY (v0.2.0.0 + endpoint impl)

### PRs mergée
| PR | Version | Feature |
|---|---|---|
| #49 | v0.2.0.0 | Phase 1 chunked pipeline (Bug C fix) |

### Architectural change shipped
- Monolithic `runSync()` → 3 cron functions: `runSyncInit` / `runSyncRefreshChunk` ×4 / `runSyncFinalize`
- `REFRESH_CHUNK_SIZE = 2500` — each chunk ~60s, well within 200s budget
- State: `Phase1Checkpoint` in settings table (JSON blob, same pattern as `ShopifyPushCheckpoint`) — **no DB migration needed**
- Vercel Blob: `toWriteMapped` + `priceChangeEntries` serialized between phases
- Social cron `maxDuration` 120→200s (Anthropic retry overhead)
- Phase 2 Shopify push moved 06:10→08:00 UTC (freed from Phase 1 window)

### Cron schedule post-v0.2.0.0
| Time (UTC) | Route | Function |
|---|---|---|
| 06:00 | `/api/cron/sync` | `runSyncInit` — fetchAll + diff + save blob |
| 06:20, 06:40, 07:00, 07:20 | `/api/cron/sync-refresh` | `runSyncRefreshChunk` — 2500 rows/chunk |
| 07:40 | `/api/cron/sync-finalize` | `runSyncFinalize` — rebuildCounts + recordPriceChanges + notify |
| 08:00, 08:15, 08:30 | `/api/cron/sync-shopify` | Phase 2 Shopify push |
| 13:00 | `/api/cron/social` | Social cron |

### Tests
- 315/316 passing (1 pre-existing flaky: `refresh-products-batch.test.ts`)
- 97% coverage
- +31 nouveaux tests: 9 job1-sync phases + 16 cron routes + 15 blob storage unit tests

### Adversarial /review findings adressés (5/12)
- **F1**: Guard `totalChunks > MAX_REFRESH_SLOTS` → throws instead of silent abort
- **F2**: Re-read checkpoint after `refreshProducts` → skip save if concurrent invocation advanced it
- **F3**: `runSync()` manual trigger refuses if Phase 1 pipeline is in progress
- **F4**: Error notification when finalize skips due to incomplete refresh (was silent 200 OK)
- **F6**: `savePhase1Checkpoint(finalized=true)` BEFORE `deletePhase1Blob` (price history safety)

### Findings deferred (TODOS.md P3/P4)
- F7: Full blob re-read per chunk (O(n²) bandwidth)
- F8: Orphaned blobs accumulate on failed days
- F9: `verifyCronSecret` DRY (5 cron routes)
- F10: Sync history shows 0 creates / N updates for chunks (cosmetic)
- F5: Blob URL in logs (architectural constraint, accepted)

### Note: Aucune migration DB requise
Le plan original prévoyait 4 colonnes sur `sync_runs` (current_phase, refresh_chunks_total, etc.).
L'implémentation finale utilise le pattern settings table (comme Phase 2) — aucune migration.
`PRAGMA table_info(sync_runs)` montrera les colonnes originales uniquement — c'est correct.

### Validation pending — STRICT 3/3
- **10 mai 06:00–07:40 UTC**: sync-init + sync-refresh (×N chunks) + sync-finalize → 1/3
- **11 mai 06:00–07:40 UTC**: 2/3
- **12 mai 06:00–07:40 UTC**: 3/3 → **Bug C CONFIRMED CLOSED**

### Critères validation par run (TOUS requis)
- `runSyncInit` completed `status='completed'` en <80s
- Tous les sync-refresh chunks completed (`refreshDone=true` dans Phase1Checkpoint)
- `runSyncFinalize` completed `status='completed'`, notification "Sync Phase 1 finalisée" reçue
- ZERO stale locks cleared
- Phase1Checkpoint finalized=true en DB

### Feature implémentée en feature branch (PAS mergée)

**Branch:** `feature/content-generate-endpoint` (4 commits, pushée)

**Endpoint:** `POST /api/social/content/generate`
- Auth: `Bearer $CRON_SECRET` OU session cookie (dashboard)
- Body: `{ templateSlug: string, language?: "fr" }` — language default "fr"
- Flow: template → vars auto (saison/mois/category/room/hook) → Claude → `createFacebookDraft`
- Variables: `{{hook}}`, `{{season}}`, `{{saison}}`, `{{mois}}`, `{{category}}`, `{{room}}`
- Tests: 17 tests route (401/403/400/404/422/200), 17/17 verts

**Bugs fixes découverts pendant qualité validation:**
1. `{{hook}}` non résolu — templates utilisent `{{hook}}` in prompt, `buildHookedPrompt` wrappait EN PLUS → double instruction contradictoire → fix: interpolateTemplate remplace `{{hook}}` direct
2. `{{season}}` non résolu — `inspiration_vie_outdoor` utilise `{{season}}` (EN key) pas `{{saison}}` → fix: alias `season` ajouté dans vars
3. `sku` FK violation — LibSQL enforce `FOREIGN KEY (sku) REFERENCES products(sku)` en remote mode → fix: `getAnyProductSku()` helper, content_template drafts utilisent premier SKU disponible comme placeholder

**Qualité validée (3 templates):**
| Template | Mots | Note |
|---|---|---|
| sondage_debat | 72 | 7/10 — format parfait, hook promo mismatch |
| inspiration_vie_outdoor | 94 | 7/10 — contenu saisonnier excellent, hook promo mismatch |
| astuces_entretien | 106 | 8/10 — meilleur draft, hook thématiquement pertinent |

**Décision: NE PAS merger** — corriger hook filter P2 dans prochaine session AVANT merge

### P2 Follow-ups à corriger AVANT merge endpoint

**Issue 1 — Hook mismatch (stock/promo hooks pour templates éducatifs):**
- Pool 200 hooks créé pour product highlights (promo, stock, prix urgency)
- Templates education/inspiration tirent des hooks "Cette promo se termine vendredi" → posts incohérents
- Fix Option A (rapide ~30min): filtrer `mode = 'generative_seeded'` pour `triggerType = 'content_template'`
- Fix Option B (propre ~1h): sous-catégorie `editorial` dans `content_hook_categories` avec hooks lifestyle/curiosité

**Issue 2 — `facebook_drafts.sku` FK sur LibSQL:**
- `sku TEXT NOT NULL REFERENCES products(sku)` est enforced par LibSQL remote (≠ SQLite local)
- Content template drafts utilisent `getAnyProductSku()` placeholder → sémantiquement incorrect
- Fix: migration SQLite (recreate table, make `sku` nullable) — P2, pas bloquant pour merge

### Apprentissages permanents (additions session 09 mai)
17. Validation 1/3 sans Shopify push complete = NON valide (08 mai outlier)
18. Instrumentation insuffisante = deviner à chaque debug
19. Migration DB coût > économie pour catalogue actuel (settings table pattern préférable)
20. Vrai problème souvent dans le code, pas la plateforme
21. SIGKILL silencieux Vercel = artefacts trompeurs en DB (stale lock)
22. `fetchAll` variabilité (29–61s) = facteur clé sous-estimé
23. Phase 2 chunked pattern existait → à répliquer pour Phase 1 (fait en v0.2.0.0)
24. Hooks pool unique pour tous content types = anti-pattern (stock/promo hooks ≠ editorial hooks)
25. Validation qualité prompts AVANT cron auto = critique (bugs template variables non détectés sinon)
26. LibSQL remote enforce FK par défaut (≠ SQLite local sans `PRAGMA foreign_keys = ON`)

### Backlog priorisé après session 09 mai

**P1 (prochaine session):**
1. Validation Bug C 3/3 (10-12 mai, automatique — juste vérifier les logs)
2. Fix hook filter Issue 1 (~30min, Option A recommandée)
3. Merge `feature/content-generate-endpoint` + ship v0.2.1.0
4. 12 EN prompts pour Furnish Direct (~2-3h session créative)
5. Cron scheduling content_template 3×/week (~1h)

**P2:**
- `facebook_drafts.sku` migration (nullable + drop FK) — avant UI non-product drafts
- UI dashboard: preview drafts `content_template` (pas de SKU produit affiché)
- Multi-photo drafts pour content posts (1-5 images random)

**P3:**
- V2 Trending `soldPerDay` précis
- Test flaky `refresh-products-batch.test.ts`
- `recordPriceChanges` N+1 pattern

---
## TRIPLE SHIP DAY — 08 mai 2026 (3 PRs: v0.1.20.4 + v0.1.21.0 + v0.1.22.0)

### PRs mergées aujourd'hui

| PR | Version | Feature |
|---|---|---|
| #46 | v0.1.20.4 | Social cron 504 fix (ORDER BY RANDOM → two-step JS) + sync-race guard |
| #47 | v0.1.21.0 | Catalog sort: best sellers (14d) + price drop % |
| #48 | v0.1.22.0 | Content templates megastore foundation + 12 FR prompts |

### SESSION 08 mai — v0.1.22.0 — Content templates megastore foundation

**Feature shipped (PR #48):**
- 12 prompts FR production-ready (713-898 chars chacun)
- Persona Ameublo Direct, tutoiement Québec, `{{hook}}` injection
- 4 content_types: education (3), inspiration (4), engagement (3), seasonal (2)
- 2 nouvelles colonnes: `frequency_per_month`, `scopes` (JSON array)
- TypeScript: `ContentTemplate` interface + `getContentTemplates()` + `getContentTemplateBySlug()`
- Migration guard one-shot: `conseil_deco_piece` slug check (idempotent, safe sur cold start)
- Turso prod: 12 templates IDs 6397-6408, colonnes migrées

**EN prompts (TODO next session):**
- 12 `prompt_pattern_en` = `TODO_EN` pour Furnish Direct brand voice
- Estimation: 2-3h session créative

**Pipeline restant (non-produit content):**
- `POST /api/social/content/generate` → Claude API (remplacer 501 stub) (~2-3h)
- Cron scheduling non-produit (~1h)

**Tests: 267/268** (1 pre-existing dans refresh-products-batch — unrelated)

---
## SESSION 08 mai après-midi — Catalog sort feature shipped (v0.1.21.0)

### Feature shipped
- 2 nouveaux sort options sur /catalog:
  - Best sellers (14d) — units_sold DESC depuis price_history
  - Price drop % — drop_pct DESC depuis price_history
- Performance: <1s sur 18k rows price_history (indexes en place)
- LEFT JOIN NULL-safe pour produits sans historique

### Bugs catchés par /review (excellent adversarial)
1. Premier impl: SUM(old_qty - new_qty) classait restocks comme négatifs
   - Fix: AND change_type='stock_change' AND old_qty>new_qty
   - Match pattern getTrendingProducts() existant
2. Price drop %: pas de change_type filter + risque div-by-zero
   - Fix: change_type filter + guard division

### Use cases business
- Identifier quoi importer (best sellers Aosom non encore en store)
- Identifier price drops Aosom à exploiter
- Décision import data-driven (vs feeling)

### Tests
- 261/262 passing (1 pre-existing flaky)
- 5 nouveaux tests pour les sort patterns

### Apprentissages permanents (additions)
6. SUM(old_qty - new_qty) sans guard restocks = sort inversé
7. Match les patterns existants (getTrendingProducts) = consistency
8. /review adversarial = catche les bugs business critiques
9. Bumper VERSION + package.json en parallèle (oublié dans précédent ship)
10. /ship prépare la PR mais ne merge pas — il faut cliquer manuellement

---
## SESSION 08 mai après-midi — CRON_SECRET rotation + cleanup

### Action de sécurité
- CRON_SECRET leaked dans docs/NEXT-SESSION.md (ajouté dans la session du matin)
- Rotation immédiate dans Vercel env vars ✅
- Cleanup secret du repo (remplacé par `$CRON_SECRET`) ✅
- Force redeploy → a réveillé le cron Vercel auto-pausé

### Validation finale
- Trigger manuel `/api/cron/social`: HTTP 200 ✅
- hook_usage_history: 3 → 4 ✅

### Validation J+1 (09 mai)
- Bug C cron 06:00 UTC: validation 2/3 attendue
- Social cron auto 13:00 UTC: a-t-il tourné? (sera 1/3 healthy si oui)
- Si non → re-investiguer Vercel cron pause

### Apprentissages permanents
6. **Ne JAMAIS coller un secret dans docs** — même un curl example; utiliser `$CRON_SECRET` ou `<token>`
7. **Vercel cron auto-pause nécessite Resume manuel ou redeploy** — un nouveau deploy ne réactive pas automatiquement un cron pausé après 504s

---
## SESSION 08 mai — Social cron 504 fix shipped (v0.1.20.4) + sync-race guard

### What shipped
- **PR #46** (`fix/social-cron-random-bottleneck`) merged → v0.1.20.4 live
- **Root cause**: `ORDER BY RANDOM()` on 10k+ products = full table scan on Turso = 60-82s → Vercel 504
- **Fix**: two-step pattern in `getEligibleHighlightProduct()`:
  - Step 1: `SELECT sku WHERE filters` → get eligible SKU list (~4s)
  - Step 2: `Math.floor(Math.random() * skus.length)` in JS → pick randomly
  - Step 3: `SELECT * WHERE sku = ? AND shopify_product_id IS NOT NULL AND qty > 0` → re-validate
- **Sync-race guard**: step-2 re-validates eligibility; concurrent sync could zero `qty` between the two queries → without guard, a 30-day `last_posted_at` poison would be set for an OOS product
- **7 new tests** added covering all paths (pool, edge cases, TOCTOU)
- **Package.json drift fixed**: `/ship` ALREADY_BUMPED path left package.json at 0.1.20.3 while VERSION was 0.1.20.4. Health endpoint reads `pkg.version`, so prod was showing wrong version. Fixed and pushed directly to main.
- **Prod confirmed**: `curl https://aosom-sync.vercel.app/api/health` → `{"version":"0.1.20.4"}`

### Vercel cron auto-pause (CRITICAL — action required)
Vercel auto-pauses cron schedules after consecutive 504 timeouts. The social cron is **paused** and will NOT run automatically, even after the deploy.

**Required action (once)**: Vercel Dashboard → Settings → Crons → click **Resume** on `/api/cron/social`

After resuming, validate with:
```bash
curl -i "https://aosom-sync.vercel.app/api/cron/social" \
  -H "Authorization: Bearer $CRON_SECRET"
```
Expect: HTTP 200, new row in `hook_usage_history` (count goes from 3 to 4+), new `facebook_drafts` row.

```sql
-- Validate social cron worked
SELECT id, hook_id, status, content_type, substr(fr_caption, 1, 80) as fr_preview, created_at
FROM facebook_drafts
ORDER BY id DESC LIMIT 3;

SELECT COUNT(*) FROM hook_usage_history;
```

### Bug C validations still pending
- **09 mai 06:00 UTC**: validation 2/3
- **10 mai 06:00 UTC**: validation 3/3

Morning routine query:
```sql
SELECT id, status, total_products,
  CAST((julianday(completed_at) - julianday(started_at)) * 86400 AS INTEGER) as duration_s,
  timing_ms
FROM sync_runs
WHERE date(started_at) = date('now')
  AND time(started_at) BETWEEN '06:00:00' AND '06:10:00'
ORDER BY started_at DESC LIMIT 1;
```
Criteria: `status='completed'`, `duration_s < 150`.

### Lessons learned
1. **`ORDER BY RANDOM()` is a full table scan on Turso** — 10k rows = 60-82s. Two-step JS random is always better when the filtered set fits in memory.
2. **TOCTOU race in two-step patterns** — always re-validate eligibility on the second query when state can change between steps (concurrent writes).
3. **`/ship` ALREADY_BUMPED doesn't check package.json** — if VERSION was pre-bumped manually, the ship pipeline skips the bump step but doesn't detect package.json drift. Fix: check both VERSION and package.json in the idempotency guard.
4. **Vercel cron pause is silent** — after 504s, Vercel stops the schedule without any visible alert. Always verify "Resume" in dashboard after fixing a cron timeout bug.
5. **CRON_SECRET curl format**: `-H "Authorization: Bearer <token>"` — not just `-H "<token>"`.

---
## SESSION 07 mai après-midi — Trending fix shipped (v0.1.20.3)

### Bug fixed
- Dashboard Trending Products: "undefined/day" et "undefined left"
- Mismatch interface vs API response
- 3 fichiers modifiés:
  - `database.ts`: ajout `p.qty AS current_qty` dans `getTrendingProducts`
  - `route.ts`: calcul `soldPerDay`/`currentQty`/`daysTracked` côté API
  - `dashboard-client.tsx`: cleanup interface `TopSeller` (`color`/`productType` retirés)
- 3 tests ajoutés (250/251)

### V1 simplification appliquée
- `soldPerDay = unitsMoved / 14` (fenêtre fixe)
- Pour produits récents (< 14 jours), valeur sous-estimée
- Acceptable pour V1

### V2 enhancement (P3 backlog)
- Calculer `soldPerDay` avec `daysSinceFirstSeen` précis
- Effort: 15-20 min en session future
- Priorité: P3 (cosmétique, pas urgent)

### Validation visuelle confirmée
- Dashboard Trending Products affiche maintenant chiffres réels
- Format: `$XX.XX | N left` + `X.X/day · 14d tracked`

---
## SESSION 07 mai — Bug C step 3 SHIPPED (v0.1.20.2)

### Root cause finally identified (after 17 days)
- Step 1 (region YUL1): blob fetch fixed
- Step 2 (ETA exclusion): one volatile field excluded
- Step 3 (brand fix): the REAL root cause = code inconsistency
  between csv-fetcher.ts (returned firstWord) and DB historical
  data (stored "Aosom")
- 7,500 false positive description diffs daily eliminated

### Fix
- 2 lines changed (csv-fetcher.ts + product-diff.ts)
- Math: toWrite ~9,000 → ~2,500
- Phase 1: 204s → ~140s estimated

### VALIDATION CRITIQUE — 3 crons consécutifs healthy
- 08 mai 06:00 UTC: 1/3
- 09 mai 06:00 UTC: 2/3
- 10 mai 06:00 UTC: 3/3
→ Bug C definitively closed après 3 jours healthy

### Action morning routine (chaque matin):
```sql
SELECT id, status, total_products,
  CAST((julianday(completed_at) - julianday(started_at)) * 86400 AS INTEGER) as duration_s,
  timing_ms
FROM sync_runs
WHERE date(started_at) = date('now')
  AND time(started_at) BETWEEN '06:00:00' AND '06:10:00'
ORDER BY started_at DESC LIMIT 1;
```

Critère par jour:
- status = 'completed' ✅
- duration_s < 150s ✅
- toWrite < 500 (real changes only)

### Plan B — Variante B chunked (backlog)
Si Phase 1 commence à dépasser 250s dans le futur:

Trigger:
- 3+ crons 06:00 UTC > 250s dans une semaine
- OU catalogue dépasse 15,000 produits
- OU duration_s grimpe sans raison apparente

Action:
- Implémenter chunked Phase 1 sur 24h spread (Variante B)
- Effort estimé: 4-5h en session dédiée
- Plan détaillé documenté dans memory Claude (sessions 06-07 mai)

### Apprentissages permanents (saga 17 jours)
1. **Patches successifs cachent la vraie cause root**
   - Step 1 (region) résolu un symptôme (blob fetch)
   - Step 2 (ETA) résolu un autre symptôme
   - Step 3 (brand) = vraie cause révélée par investigation rigoureuse
   - **Sans investigation field-by-field, on aurait shippé Variante B inutilement**

2. **Investigation field-by-field obligatoire** quand bug récurrent
   - Pas spéculer "c'est probablement X"
   - Comparer DB vs CSV pour 5-10+ produits réels
   - Identifier TOP 3 champs avec diffs

3. **Bug peut venir d'incohérence interne du code**, pas de Aosom externe
   - Code A (csv-fetcher) + Code B (DB schema) doivent rester cohérents
   - Refactor parallèle peut désynchroniser silencieusement

4. **Discipline anti-célébration**
   - "Closed" = 3 crons consécutifs healthy
   - Pas avant
   - 17 jours de saga = 3 jours de patience pour validation

5. **GitHub auth peut expirer en milieu de session**
   - PAT (Personal Access Token) plus stable que device flow
   - À documenter dans setup local

---
## ✅ INCIDENT 06 mai RÉSOLU — Social cron débloqué après 4 jours de panne

### Symptôme
- 0 drafts FB générés depuis 01 mai (4 jours sans posts)
- 304 drafts en DB tous avec hook_id=NULL (format pré-hook)
- hook_usage_history vide

### Cause racine identifiée (preuve directe)
- ANTHROPIC_API_KEY dans Vercel env contenait `\n` parasite (110 chars vs 108)
- Test API direct: clé 110 chars → authentication_error, 108 chars → 200 OK
- Première hypothèse "modèle déprécié" RÉFUTÉE par test direct (modèle valide)
- Vraie cause: clé corrompue, probablement re-saisie avec retour ligne vers 02 mai

### Fix appliqué
- Aucun code modifié
- Nouvelle clé Anthropic créée (Console)
- Re-saisie clean dans Vercel Dashboard
- Redeploy

### Validation prod (06 mai 14:30 UTC)
- Trigger manuel cron `/api/cron/social` → 200 OK en 98s
- **Premier hook de l'histoire** (hook_usage_history ids 1 et 2):
  - FR: mode `generative_seeded` — Claude varie depuis seed du pool
  - EN: mode `pool` — hook verbatim depuis pool
- fr_caption: "Cuisiner devient un vrai plaisir..."
- en_caption: "Some spaces change your mood the moment you walk in."
- Format pré-hook ("COUP DE CŒUR") DISPARU

### Validation auto (07 mai 13:00 UTC)
**À VÉRIFIER demain matin** — cron auto doit tourner sans intervention.

### Apprentissages permanents
1. **Toujours valider hypothèses avec preuve directe avant fix**
   - Aujourd'hui: hypothèse "modèle déprécié" était plausible mais FAUSSE
   - Sans test API direct, on aurait shippé un fix raté qui changeait le modèle pour rien
2. **Vérifier env vars de length attendue**
   - ANTHROPIC_API_KEY = 108 chars exact
   - 110 chars = parasite (probablement \n du paste)
3. **Vercel logs CLI ne montre que 100 dernières lignes**
   - Pour debug cron éloigné dans le temps, utiliser dashboard ou queries DB
4. **Cron Vercel se "pause" silencieusement après 2-3 échecs consécutifs**
   - Pas un echec visible — disparaît juste des logs
   - Toujours valider le succès post-deploy par trigger manuel

### Backlog P3 (nouveaux items)
- **hook_usage_history.product_scope_used absent du schema** (P3)
  - Divergence vs spec validée 04 mai
  - Pas critique pour la logique, mais perd traçabilité analytics
  - À ajouter dans une session future

---

## ⏳ VALIDATIONS CRITIQUES DEMAIN MATIN (07 mai)

### 1. Bug C cron 06:00 UTC (validation 2/3)

```sql
SELECT id, status, total_products,
CAST((julianday(completed_at) - julianday(started_at)) * 86400 AS INTEGER) as duration_s,
timing_ms
FROM sync_runs
WHERE date(started_at) = date('now')
AND time(started_at) BETWEEN '06:00:00' AND '06:10:00'
ORDER BY started_at DESC LIMIT 1;
```

Attendu: status='completed', duration_s entre 80-280s
Actuel count: 1/3 (06 mai cron passé à 274s, marge 26s)
Cible: 3/3 pour déclarer Bug C definitively closed

**À NOTER**: Bug C step 2 a fixé la pollution ETA, mais
refreshProducts prend toujours 149s même avec 0 updates
(architecture issue à investiguer dans une session future).

### 2. Social cron auto 13:00 UTC (validation 1/3)

```sql
SELECT id, status, hook_id, content_type,
substr(fr_caption, 1, 100) as fr_preview,
created_at
FROM facebook_drafts
WHERE date(created_at) = date('now')
AND time(created_at) BETWEEN '13:00:00' AND '13:05:00'
ORDER BY created_at DESC LIMIT 3;
```

Attendu: au moins 1 draft, hook_id non-null, fr_caption variée
Actuel: 1 draft manuel créé aujourd'hui (id=305)
Cible: cron auto doit tourner sans intervention

---

## 🎯 Prochain chantier (au choix)

Une fois validations OK, choisir:

1. **Quick win Dashboard "In store" indicator** (~1h)
   - Sur Price Drops + Fastest Selling panels
   - Aide curation: voir d'un coup d'œil ce qui est importé

2. **Feature contenu non-produit** (~4-5h)
   - 12 templates méga-store déjà cadrés (validé 05 mai)
   - 24 prompts FR/EN à écrire
   - Couverture 7 product scopes

3. **Bug C step 3 — investigation 149s mystery** (~2-3h)
   - refreshProducts prend 149s même avec 0 updates
   - Probablement architecture issue (itère sur tout avant de check)
   - Pas urgent (cron passe à 274s avec marge 26s)
   - Mais sécurise le futur

4. ~~**Catalogue sorting options** (~3-4h)~~ ✅ Shipped in v0.1.21.0
   - Best sellers (14d) + Price drop % added to /catalog

---
## UPDATE 03 mai — v0.1.20.0 hook pool + hotfix deadlock ✅

### Session (03 mai 2026)

**2 commits sur main:**

| Commit | Description |
|--------|-------------|
| a226cd8 | feat(social): hook pool with rotation and product scope (v0.1.20.0) — squash de PR #42 |
| a0f9f7b | fix: deadlock in seedHooksIfEmpty — use getDb() not ensureSchema() |

**v0.1.20.0 — Hook pool rotation system:**
- 200 hooks (100 FR + 100 EN) dans `content_hooks` via `HOOKS_SEED`
- 7 scopes: universal, mobilier_indoor, outdoor_patio, pets, kids_toys_sport, storage_kitchen, bedroom_decor
- Anti-repeat rotation: 5 dernières catégories exclues (`getRecentHookCategoryIds` avec DISTINCT)
- 60% pool (verbatim) / 40% generative_seeded
- 3 review auto-fixes: LIKE paramétrisé, DISTINCT rotation, "Home Decor" ASCII variant
- 8 hooks pool→generative_seeded (compliance Loi protection consommateur QC — fausses quantités/délais)
- DB tables: `content_hook_categories`, `content_hooks`, `hook_usage_history`
- `facebook_drafts.hook_id` FK nullable ajoutée

**Hotfix critique — deadlock async:**
- `seedHooksIfEmpty()` appelait `ensureSchema()` depuis l'intérieur de `_initSchemaImpl()`
- Deadlock: `schemaPromise` attendait `seedHooksIfEmpty()`, qui attendait `schemaPromise`
- Symptôme: health endpoint timeout sur chaque cold start, `content_hooks` vide en prod
- Fix: `getDb()` directement (client déjà créé à ce stade)

**Tests:** 242/243 (1 pre-existing timeout dans refresh-products-batch — non lié)

**Scopes distribution:**
- mobilier_indoor: ≥30 hooks/langue (multi-tagged)
- universal: ≥5 hooks/langue (fallback pool)
- outdoor_patio, pets, kids_toys_sport, storage_kitchen, bedroom_decor: couverts

---

### Instructions reprise (à valider au début de la prochaine session)

```bash
cd ~/.gstack/projects/aosom-sync
git checkout main && git pull origin main --ff-only
```

**Étape 1 — Valider health prod:**
```bash
curl -s https://aosom-sync.vercel.app/api/health | jq
# Attendu: { "version": "0.1.20.0", "status": "ok/degraded", "db": true }
```

**Étape 2 — Valider seed Turso prod:**
```sql
SELECT language, COUNT(*) as count FROM content_hooks GROUP BY language;
-- Attendu: 100 FR + 100 EN = 200 total
-- Si 0: seed n'a pas run → vérifier que le hotfix a0f9f7b est bien déployé
```

**Étape 3 — Smoke test génération sociale:**
Tester la génération d'un draft social depuis l'UI → vérifier que `hook_id` est populé dans `facebook_drafts`.

```
Dire à Claude: "Reprise aosom-sync. Lis docs/NEXT-SESSION.md UPDATE 03 mai.
Valide health 0.1.20.0, seed count 200, smoke test hook_id populé."
```

---
## UPDATE 02 mai (4) — fin de session — Bug C et Bug B résolus ✅

### Journée complète (02 mai 2026)

**4 PRs mergées + 1 commit direct:**

| # | PR/Commit | Version | Description |
|---|---|---|---|
| 1 | PR #38 | v0.1.18.0 | Bug C définitif: pre-cache CSV dans Vercel Blob (store public yul1) |
| 2 | PR #39 | v0.1.18.1 | Hotfix: BLOB_FETCH_TIMEOUT_MS 10s → 30s |
| 3 | PR #40 | v0.1.18.2 | Hotfix: BLOB_FETCH_TIMEOUT_MS 30s → 60s (45MB × 1.5 MB/s = 30s body read seul) |
| 4 | e766276 | v0.1.18.3 | Perf: `"regions": ["yul1"]` dans vercel.json (co-locate functions avec Blob) |
| 5 | PR #41 | v0.1.19.0 | Bug B: UX published drafts (disabled buttons, badge fr-CA, confirm delete, panel guard) |

**Tests:** 185/185 → 199/199 (+14)
**Health prod:** `{"status":"ok","db":true,"version":"0.1.19.0"}` confirmé 23:53 UTC

---

### Apprentissages permanents

1. **Region Vercel = root cause cachée** — Function `iad1` + Blob `yul1` = cross-region body read 30s. Toujours vérifier `x-vercel-id`: `yul1::iad1` = problème, `yul1::yul1` = OK.
2. **`AbortSignal.timeout()` couvre TOUT le body read** — pas seulement le headers handshake. 45MB à 1.5 MB/s depuis Vercel function = 30s body read seul. Margin = 2×.
3. **Vercel Blob public store (yul1)** — pattern éprouvé pour cacher gros fichiers (45MB). Store privé initial = erreur; recréer en mode public est la solution.
4. **`toLocaleDateString` + options time = non-standard ECMA-402** — utiliser `toLocaleString` avec `{ day, month, hour, minute }`. Tester le format fr-CA en isolation.
5. **Test mirror pattern** — sans @testing-library/react, dupliquer les helpers purs dans le fichier test. Drift detection = manuel; syncer les deux à chaque modification.

---

### Bugs en backlog post-session

- **publishedAt sur drafts non-published (P3)**: `SELECT id, status, published_at FROM facebook_drafts WHERE published_at IS NOT NULL AND status != 'published'`
- **Server-side guards pour drafts published (P3)**: `approve`/`reject` dans route.ts ne vérifient pas status='published' → ajouter check + return 400
- **import/queue timeout (P3)**: `queueForImport()` appelle `fetchAosomCatalog()` — si blob unavailable → timeout 60s. Fix: lire depuis `catalog_snapshots` DB.
- **content_type dans FacebookDraft interface (P3)**: colonne existe en DB (v0.1.16.0) mais pas dans le TypeScript interface ni `mapDraft()`

---

### Query validation cron 06:00 UTC (03 mai) — CRITIQUE

Phase 1 doit compléter avec `csv_source='blob_cache'` (pas live_fallback):

```sql
SELECT id, status, total_products,
  CAST((julianday(completed_at) - julianday(started_at)) * 86400 AS INTEGER) as duration_s,
  timing_ms
FROM sync_runs 
WHERE date(started_at) = date('now')
  AND time(started_at) BETWEEN '06:00:00' AND '06:05:00'
ORDER BY started_at DESC LIMIT 1;
```

Succès: `status='completed'`, `duration_s < 200`, `timing_ms` contient `"csvSource":"blob_cache"`.
Échec: `status='running'` après 06:05 UTC → zombie → Bug C persist malgré region fix.

---

### Instructions reprise demain

```bash
cd ~/.gstack/projects/aosom-sync
git checkout main && git pull origin main --ff-only
```

1. Query cron ci-dessus → confirmer Bug C résolu sur nuit entière
2. Smoke test visuel Bug B: draft published → boutons disabled + badge "Publié le {date}"
3. Next: voir TODOS.md (Bulk Generate P1 ou social content P2)

```
Dire à Claude: "Reprise aosom-sync. Lis docs/NEXT-SESSION.md UPDATE 02 mai (4).
Commence par la query cron 06:00 UTC pour valider Bug C + smoke test Bug B."
```

---
## UPDATE 02 mai (3) — Chantier A1 COMPLET ✅ — v0.1.18.3 region fix en prod

### Diagnostic région Vercel function vs Blob store (02 mai 2026, ~22:30-22:45 UTC)

**Hypothèse confirmée**: mismatch région = root cause du 30s body read.

| | Avant (iad1) | Après (yul1) |
|---|---|---|
| x-vercel-id | `yul1::iad1` | `yul1::yul1` |
| Précache download Aosom CDN | 9.5s | **2.3s** (4×) |
| Blob fetch depuis function | ~30s (cross-region) | **~1-2s** (co-localisé) |
| fetchAll (Shopify dominé) | 104s | **70-99s** (variable) |
| Phase 1 total (0 changes) | 287s | **78s** |

**Fix**: `"regions": ["yul1"]` dans `vercel.json`. Commit `e766276` sur main.

**Découverte clé**: `fetchAll` est dominé par Shopify API pagination (~70-99s), pas par le blob.
La vraie valeur du region fix = supprimer le risque de 30s blob + accélérer le fallback CDN.

**À surveiller**: cron 06:00 UTC — Phase 1 doit completer <250s même avec des changements.

---
## UPDATE 02 mai (2) — Bug C RÉSOLU ✅ — v0.1.18.2 en prod, Phase 1 completed

### Phase 5 validation finale (02 mai 2026, ~19:53 UTC)

**Résultat**: PR #40 (v0.1.18.2 hotfix BLOB_FETCH_TIMEOUT_MS 60s) mergée et validée.

Phase 1 manuelle déclenchée:
- Status: `completed` ✅ (pas zombie)
- Elapsed: **287s** (dans la limite 300s Vercel)
- Products synced: 10,387
- Price updates: 189, stock changes: 1,005
- Health: `ok` ✅

Pre-cache seed juste avant: 43.2 MB en 9.5s download, 1.3s upload.

**Timeline empirique BLOB_FETCH_TIMEOUT_MS:**
- 10s → fetchAll 94.7s (blob timeout 10s + CDN ~85s) → zombie
- 30s → fetchAll 81.9s (blob timeout 30s + CDN ~52s) → zombie  
- 60s → fetchAll <300s → **COMPLETED** ✅

**Root cause confirmée**: `AbortSignal.timeout()` couvre TOUT le body read.
45MB à ~1.5 MB/s depuis Vercel function = ~30s body read seul.
60s = 2× safety margin → blob hit ou CDN complète dans les temps.

**À surveiller**: Cron 06:00 UTC le 03 mai pour confirmer Bug C résolu
sur plusieurs nuits.

### Issue à traiter (prochaine session, non urgent)

`import/queue` (`maxDuration=60`) appelle `fetchAosomCatalog()`. Si blob
unavailable → timeout au 60s (pré-existant, non aggravé par ce hotfix).
Fix futur: lire depuis `catalog_snapshots` DB dans `queueForImport()`.

---
## UPDATE 02 mai — Bug C PARTIELLEMENT résolu — hotfix requis avant cron 06:00 UTC 🔧

### Phase 5 validation prod (02 mai 2026)

**Résumé**: PR #38 (v0.1.18.0) mergée, pre-cache blob fonctionnel, MAIS Phase 1 
toujours en timeout 504 à cause d'un bug dans le fix adversarial (F11).

### Friction du jour: Vercel Blob "Private" vs "Public"

Store créé initialement en mode Private. Solution: création nouveau store 
`aosom-csv-public` (Public, YUL1), redeploy Vercel pour appliquer nouveau 
BLOB_READ_WRITE_TOKEN.

Pre-cache ✅: 43.2 MB en 7.8s (download Aosom CDN 4.4s, upload Blob 1.4s)
csv_blob_cache DB row: blob_url = `.public.blob.vercel-storage.com` ✅

### Bug critique découvert: BLOB_FETCH_TIMEOUT_MS = 10s trop court

**Root cause**: Le fix adversarial F11 a réduit BLOB_FETCH_TIMEOUT_MS de 60s 
à 10s. Mais le blob de 45MB téléchargé DEPUIS une Vercel function dépasse 10s. 

Preuve timing Phase 1 (run 8fa301c3, 02 mai 19:07 UTC):
- fetchAll: 94,697ms = blob timeout (10s) + live CDN fallback (~85s)
- diff: 45ms, detectChanges: 33ms
- refreshProducts: killed par Vercel à 300s (zombie)
- Résultat: 504 Gateway Timeout

Blob URL accessible localement en 1.6s @ 28 MB/s. Mais depuis Vercel function,
throughput différent — possiblement 4-5 MB/s → 45MB prend 9-11s → timeout 10s.

### Hotfix requis — UNE LIGNE DE CODE

Dans `src/lib/csv-fetcher.ts` ligne 8:
```
// AVANT:
const BLOB_FETCH_TIMEOUT_MS = 10_000;

// APRÈS:
const BLOB_FETCH_TIMEOUT_MS = 30_000;  // 30s covers 45MB at 1.5 MB/s minimum
```

30s est conservateur mais safe: si le blob prend >30s, c'est anormal et le
live fallback (240s budget) est préférable. Le sync budget (300s) absorbe
30s + parseTsv (~3s) + refreshProducts (~15s) confortablement.

### À faire IMMÉDIATEMENT en début de prochaine session

1. Hotfix: `BLOB_FETCH_TIMEOUT_MS = 10_000` → `30_000` dans csv-fetcher.ts
2. Aussi mettre à jour le test "AbortError fallback" pour refléter la nouvelle valeur
3. Version bump 0.1.18.0 → 0.1.18.1 (patch hotfix)
4. PR + merge + redeploy
5. Re-trigger Phase 1 pour validation

### État au 02 mai

- v0.1.18.0 en prod (blob cache actif, hotfix BLOB_FETCH_TIMEOUT en attente)
- Store Vercel Blob `aosom-csv-public` actif, csv_blob_cache row OK
- 185/185 tests
- 0 zombies après cleanup  
- Bug C: 🔧 PARTIELLEMENT résolu — blob cache en place, hotfix timeout requis

### Validation cron 06:00 UTC 03 mai — ATTENTE CRITIQUE

Sans le hotfix, le cron de ce soir va probablement timeout encore.
Avec le hotfix appliqué ce soir: le cron de demain devrait compléter en <200s.

Query post-cron:
```sql
SELECT id, status, total_products,
  CAST((julianday(completed_at) - julianday(started_at)) * 86400 AS INTEGER) as duration_s,
  timing_ms
FROM sync_runs 
WHERE date(started_at) = date('now')
  AND time(started_at) BETWEEN '06:00:00' AND '06:05:00'
ORDER BY started_at DESC LIMIT 1;
```

### Backlog post-Bug C

- Bug B (P2): UX published posts (boutons, badge "Posted at")
- Feature contenu non-produit (P2): écriture 24 prompts FR/EN templates
- content-generator timeout (P3): 90s pattern
- recordPriceChanges N+1 (P3): non-bottleneck nominal

### Pour reprendre demain

```bash
cd ~/.gstack/projects/aosom-sync
git checkout main && git pull origin main --ff-only
```

Dire à Claude: "Appliquer hotfix BLOB_FETCH_TIMEOUT_MS 10s→30s dans 
csv-fetcher.ts, bump 0.1.18.1, PR + merge + validate Phase 1."

---
## UPDATE 26 avril fin de session — Bug C DÉFINITIVEMENT RÉSOLU 🎉

### Saga Bug C: 16 jours, 5 PRs, résolution complète

**Diagnostic final**: Bug C nightly Phase 1 timeout était causé par
refreshProducts utilisant batch_size=100 au lieu de 1000.

Les "195s mystérieuses" précédemment observées étaient applyToShopify
qui tournait parce que les triggers de test ne passaient pas correctement
shopifyPush:false. Phase 1 réelle (cron 06:00 UTC) avec dbSync:true
seulement = ~80s.

### PRs de la journée (5)

✅ PR #34 (v0.1.16.0) — Infrastructure feature contenu non-produit
   12 templates seedés, endpoints stubs (501), migration content_type

✅ PR #35 (v0.1.17.0) — Plan B Turso TEXT cache → REVERTÉE
   Hypothèse "Turso TEXT 45MB read = 50ms" INVALIDÉE
   Mesure réelle: 62s. Apprentissage: Turso optimisé pour rows
   quelques KB, PAS pour blobs 45MB. Door closed.

✅ PR #36 (v0.1.16.1) — batch_size 100→1000 sur refreshProducts
   refreshProducts: ~824s estimé worst case → 11s mesuré
   1 ligne + 1 test + commentaires

✅ PR #37 (v0.1.16.2) — Instrumentation Phase 2
   Logs Pino sur applyToShopify, addSyncLogsBatch, createNotification
   À valider via prochain Phase 2 cron naturel

### Mesures finales Phase 1 (cron 06:00 UTC simulé)

| Phase                    | Durée        |
|--------------------------|--------------|
| clearStaleLock           | 1.7s         |
| createSyncRun            | 0.2s         |
| fetchAll (CSV+snap)      | 75s          |
| diff + detectChanges     | <0.2s        |
| refreshProducts          | 0-11s        |
| rebuildProductTypeCounts | 1.6s         |
| recordPriceChanges       | 0-1s         |
| completeSyncRun          | <0.1s        |
| **TOTAL Phase 1**        | **~80s** ✅  |

### Apprentissages permanents

1. Multiple bottlenecks coexistent — fix d'un peut révéler le suivant
   ou montrer qu'il n'existait pas (cas applyToShopify mystery)
2. Empirical measurement > speculation — bench AVANT code (PR #35 leçon)
3. Local WSL2 ≠ Vercel prod — valider en prod (bench local pour ratios)
4. Turso super-linéaire sur gros batches (insight réutilisable)
5. Turso TEXT blobs 45MB = anti-pattern (use Vercel Blob/S3 si besoin)
6. Pattern PR review ↔ Adversarial = bug catcher éprouvé
7. Discipline checkpoint humain — Phase F aujourd'hui a sauvé d'un
   non-bug

### Bugs en backlog post-Bug C

- fetchAll variable (P2): 51-151s daytime — accepter, OK budget
- Bug B (P2): UX published posts
- Feature contenu non-produit (P2): écriture 24 prompts FR/EN
- content-generator timeout (P3): 90s pattern
- recordPriceChanges N+1 (P3): non-bottleneck en nominal

### État final

- v0.1.16.2 en prod
- 170/170 tests
- 0 zombies
- Bug C: ✅ RÉSOLU après 16 jours

### Pour reprendre demain

Vérifier que cron 06:00 UTC s'est exécuté en <120s. Si oui, Bug C
définitivement clos historiquement.

```
cd ~/.gstack/projects/aosom-sync
git checkout main && git pull origin main --ff-only
```

---
## UPDATE 26 avril fin de session — Bug C partiellement résolu, nouveau goulot identifié

### Wins de la journée

✅ **PR #34** mergée — infrastructure feature contenu non-produit (v0.1.16.0)
   - 12 templates seedés avec placeholders
   - Endpoints stubs (501 NOT_IMPLEMENTED)
   - Migration content_type sur facebook_drafts

✅ **PR #35** testée puis revertée — Plan B Turso TEXT cache (échec empirique)
   - Hypothèse "Turso TEXT 45MB read = 50ms" INVALIDÉE par mesure prod
   - Mesure réelle: 62s pour SELECT raw_text 45MB
   - Apprentissage: Turso optimisé pour rows quelques KB, pas blobs 45MB
   - Revert clean (commit 517225e)

✅ **PR #36** mergée — batch_size 100→1000 (v0.1.16.1)
   - Mesure empirique: Turso super-linéaire sur gros batches
   - refreshProducts: 824s estimé → **11s mesuré** (75× plus rapide)
   - 1 ligne de code + 1 test + commentaires sur autres usages batch=100

### Bug C status: PARTIELLEMENT résolu

**Avant ce matin:**
- Phase 1 timeout 300s+ chaque nuit
- Phase 1 daytime 232s (limite)
- Hypothèse: refreshProducts = bottleneck

**Après PR #36:**
- refreshProducts: 11s (était bottleneck principal, RÉSOLU)
- Phase 1 daytime: TOUJOURS timeout 302s
- Nouveau diagnostic via instrumentation:

| Phase                    | Durée mesurée | Verdict          |
|--------------------------|---------------|------------------|
| fetchAll (CSV+snap)      | 90.5s         | ⚠️ Variable      |
| refreshProducts          | 11s           | ✅ FIX confirmé  |
| rebuildProductTypeCounts | 1.6s          | ✅               |
| recordPriceChanges       | 1.0s          | ✅               |
| diff + detectChanges     | 0.1s          | ✅               |
| Init + locks             | 2.7s          | ✅               |
| **Sous-total mesuré**    | **~107s**     |                  |
| **Gap non instrumenté**  | **~195s**     | 🚨 NOUVEAU BUG   |
| **Total observé**        | **302s**      | ❌ TIMEOUT       |

### Plan prochaine session — Identifier les 195s mystérieuses

**Étape A** — Instrumentation Pino sur les phases finales (15 min)
   Candidates probables:
   - completeSyncRun (UPDATE sync_runs avec metadata)
   - addSyncLogsBatch (flush des logs accumulés batch=100)
   - Quelque chose entre recordPriceChanges et completeSyncRun

**Étape B** — Trigger Phase 1 manuel + capture logs (5 min)

**Étape C** — Identifier précisément la phase coupable (5 min)

**Étape D** — Fix selon la nature du bug:
   - Si addSyncLogsBatch lent: batch_size 100→1000 (pattern même que PR #36)
   - Si completeSyncRun lent: investigation différente
   - Si autre chose: adapter

Estimation totale: 1-2h selon nature du bug.

### Ce qu'on a appris cette saga (16 jours)

1. **Multiple bottlenecks** peuvent cohabiter sur Phase 1 — fix d'un révèle le suivant
2. **Instrumentation prod > spéculation** — chaque hypothèse doit être validée empiriquement
3. **Mesures locales WSL2 ≠ prod Vercel** — toujours valider en prod
4. **Turso super-linéaire** sur gros batches (apprentissage clé)
5. **Cache TEXT 45MB Turso = anti-pattern** (cache fermée définitivement)
6. **Pattern PR review ↔ Adversarial** = bug catcher éprouvé (PR #28 hasChanged)

### Bugs en backlog

- **Bug C step 2** (P0): identifier les 195s mystérieuses — prochaine session
- **fetchAll variable** (P1): 51-151s selon journée — pré-cache toujours possible mais avec architecture différente (Vercel Blob, pas Turso TEXT)
- **Bug B** (P2): UX published posts
- **Feature contenu non-produit** (P2): écriture des 24 prompts FR/EN dans session créative dédiée

### État final session

- v0.1.16.1 en prod
- 170/170 tests
- Phase 2 cron toujours opérationnel (compense Phase 1 fail business-wise)
- 0 zombies après cleanup
- 4 PRs traitées aujourd'hui (#34 mergée, #35 revertée, #36 mergée, et le revert de #35)

### Commande pour reprendre

```
cd ~/.gstack/projects/aosom-sync
git checkout main && git pull origin main --ff-only
```

Dire à Claude: "Reprise aosom-sync. Lis docs/NEXT-SESSION.md 'UPDATE 26
avril fin de session'. Je veux identifier les 195s mystérieuses dans
Phase 1. Commence par instrumenter completeSyncRun + addSyncLogsBatch."

---
## UPDATE 26 avril fin de journée — Bug C root cause CORRIGÉE (encore)

### Wins de la session

✅ PR #34 mergée: infrastructure feature contenu non-produit
   - 12 templates seedés (placeholders prompts pour session créative future)
   - Endpoints API stubs (501 NOT_IMPLEMENTED)
   - Migration content_type sur facebook_drafts

✅ PR #35 testée puis revertée: Plan B Variante B (Turso TEXT cache)
   - Hypothèse "Turso 45MB read = 50ms" INVALIDÉE par mesure prod
   - Mesure réelle: 62s pour SELECT raw_text 45MB via Turso HTTP API
   - Régression: 232s daytime → 301s timeout
   - Revert clean (commit 517225e)
   - **Apprentissage**: Turso optimisé pour rows quelques KB, PAS pour blobs 45MB

✅ Diagnostic définitif du VRAI Bug C avec instrumentation prod:
   - Bug C N'EST PAS un problème de CSV fetch (52s OK aujourd'hui)
   - Bug C EST un problème de DB write phase (refreshProducts >245s sur
     grosses journées de changes Aosom)
   - Mesure prod 26 avril 15:52 UTC:
     * fetchAll: 52s ✅
     * refreshProducts: >245s ❌ (timeout avant complétion)
     * Total: >300s ❌ Vercel SIGKILL

### Erreurs honnêtes de cette session

1. Hypothèse "Turso TEXT read fast" non validée empiriquement avant code
2. Plan B Variante B shippée sans test de vitesse réelle
3. Régression prod (Phase 1 daytime cassée pendant ~30 min)
4. Heureusement: revert disponible, Phase 2 compense côté business

### Nouvelle compréhension de Bug C

| Phase                | Mesure prod 26 avril | Verdict          |
|----------------------|----------------------|------------------|
| fetchAll (CSV+snap)  | 52s                  | OK ✅            |
| diff + detectChanges | <1s                  | OK ✅            |
| refreshProducts      | >245s                | BOTTLENECK ❌    |
| recordPriceChanges   | (pas atteint)        | TBD              |
| TOTAL                | >300s                | TIMEOUT ❌       |

refreshProducts varie selon volume:
- Hier 25 avril: 161s (jour normal)
- Aujourd'hui 26 avril: >245s (backlog accumulé après fail 06:00 UTC)

### Plan prochaine session — VRAI fix Bug C

**Architecture cible: chunking + checkpoint pattern (comme Phase 2)**

Modèle:
- Phase 1 actuelle: 1 invocation Vercel, tout ou rien (vulnerable à 300s)
- Phase 1 chunked: split refreshProducts en chunks 2000 rows
  * Run 1 (06:00): processe rows 0-2000, sauvegarde checkpoint, retourne
  * Run 2 (06:15 cron): reprend rows 2001-4000, etc.
  * Pattern existant sur Phase 2 (3 runs cascade)
- Estimation: 6 invocations × 40-60s chacune = sous 300s par invocation

**Préalables session prochaine:**

1. Mesure empirique batch size (15 min)
   - refreshProducts actuelle: batches 100
   - Tester localement: batches 100, 500, 1000 sur 2000 rows
   - Choisir taille optimal avant code

2. Design pattern checkpoint (15 min)
   - Table sync_checkpoints (id_run, last_processed_row, status)
   - Idempotency: si crash mid-batch, reprend depuis checkpoint
   - Ressemble au pattern Phase 2

3. Implémentation (1-2h)
   - Refactor refreshProducts pour accepter offset/limit
   - Modifier runSync pour gérer continuation
   - Cron secondaire 06:15 + 06:30 + 06:45 si nécessaire

4. Tests + validation prod

Estimation totale: 2.5-3h session dédiée.

### NE PAS FAIRE prochaine session

- Vercel Blob storage (résoudrait CSV fetch qui n'est pas le bottleneck)
- Optimisation prématurée (Turso, network, etc.)
- Hypothèses non validées par mesure

### État final session

- Branche main: clean, version 0.1.16.0 (post-revert)
- PR #34 mergée et OK (feature infra)
- 0 zombies sync_runs
- Tests: 169/169 (post-revert, on a perdu 23 tests liés à PR #35)
- Bug C: diagnostic clair, plan pour fix demain

### Bugs en attente

- **Bug C (P0)**: chunking Phase 1 — session prochaine
- **Bug B (P2)**: UX published posts
- **content-generator timeout (P2)**: 90s pattern
- **recordPriceChanges N+1 (P2)**: déjà noté, à fixer un jour

### Commande pour reprendre

```bash
cd ~/.gstack/projects/aosom-sync
git checkout main && git pull origin main --ff-only
```

Dire à Claude: "Reprise aosom-sync. Lis docs/NEXT-SESSION.md 'UPDATE
26 avril fin de journée'. Je veux attaquer le VRAI Bug C: chunking
refreshProducts. Commence par la mesure empirique batch sizes."

---
## UPDATE 25 avril fin d'après-midi — 5 PRs shipped, journée exceptionnelle

### Wins de la journée

PR #30 (0.1.14.1) - Per-phase timing logs Phase 1
PR #31 (0.1.14.3) - Bug C: CSV body stream timeout (Phase 1 nightly fix)
PR #32 (0.1.15.0) - Bug A: Scheduled posts cron worker
PR #33 (0.1.15.1) - Atomic claim race condition fix
PR #34 (0.1.16.0) - Infrastructure feature contenu non-produit

Tests: 147 → 169 (+22)
TODOS.md: Bug A completed, infrastructure complete

### Prochaine session — Creative writing

Objectif: remplir les 24 prompts FR/EN des content_templates
(12 × 2 langues) avec persona-aware tones:
- Ameublo Direct (FR): tutoiement Quebec, ton chaleureux/complice
- Furnish Direct (EN): "you" direct, neutral Canadian

Templates à compléter (slugs):
INFORMATIVE: seasonal_tip, mistake_listicle, myth_vs_reality, product_comparison
ENTERTAINING: relatable_meme, pov_scenario, nostalgic_throwback, design_quote
ENGAGEMENT: this_or_that, guess_the_price, caption_this, unpopular_opinion

Plus: implémenter le code de génération réelle (Anthropic API call)
et l'UI sur /social.

Estimation: 2-3h focus dédiée.

### Bugs en attente

- Bug B UX (publishing badge sur drafts published) — 1h
- Limitation: publishing orphan si Vercel kill à 120s — edge case
- Limitation: sort newest-first au lieu de FIFO — cosmétique

Status prod: tout fonctionnel, 0 zombies, version 0.1.16.0.

---
## UPDATE 25 avril après-midi — Bug A résolu (scheduled posts) v0.1.15.0

### Ce qui est shipped (PR #32, v0.1.15.0)

✅ processScheduledDrafts() — cron worker dédié pour les scheduled posts
✅ /api/cron/social-scheduled — GET (Vercel cron) + POST (trigger manuel)
✅ Vercel cron schedule: 0,15,30,45 * * * *  (toutes les 15 min)
✅ 161/161 tests (14 nouveaux dont route 401/500, edge cases, partial success)
✅ Fix adversarial: verifyCronSecret catch CRON_SECRET manquant → 401 pas 500
✅ PR #32 mergée à 17:23 UTC

### 3 drafts bloqués en prod (P1)

IDs 279, 291, 283 — stuck depuis 2-4 jours avec status='scheduled'.
→ Prochain cron (toutes les 15 min) ou trigger manuel:
  POST /api/cron/social-scheduled avec session cookie
→ Vérifier dans Turso: SELECT id, status, sku, scheduled_at FROM facebook_drafts WHERE id IN (279, 291, 283);
→ Vérifier visuellement: Facebook Ameublo Direct + Furnish Direct

### Bugs toujours en attente

**Bug B — UX published posts (P2, ~1h)** — affichage et gestion des posts publiés
**Bug C — Phase 1 nightly** — 75% résolu (voir ci-dessous), surveiller log du 26 avril

---
## UPDATE 25 avril fin de matinée — Bug C ENFIN résolu en prod

### Ce qui est shipped (PR #30 + #31, v0.1.14.1, v0.1.14.2, v0.1.14.3)

✅ Per-phase timing logs (PR #30) — instrumentation Pino
✅ Fix CSV body stream timeout (PR #31) — root cause identifiée et fixée
✅ Manual Phase 1 trigger en prod: COMPLETED en 232s avec 10 253 produits
✅ Première completion Phase 1 en prod depuis le 11 avril

### Root cause finale (sur preuves)

fetchAosomCatalog body stream NON protégé par AbortController. Mécanisme:
- AbortController setTimeout 60s → fetch headers OK en <1s → clearTimeout 
  TOO EARLY → response.text() body stream démarre sans timeout
- Aosom CDN body download ~80s daytime, >240s nightly à 6h UTC
- Vercel SIGKILL à 300s avant que le sync log quoi que ce soit

Fix appliqué (csv-fetcher.ts):
- AbortController couvre fetch ET response.text() via try/finally
- Timeout 240s (marge 60s sous Vercel 300s)
- Retry retiré (incompatible avec budget Vercel + 240s timeout)
- Erreur explicite "CSV fetch exceeded 240s" si timeout

### Tableau de timing prod (run manuel 25 avril 16:28 UTC)

| Phase                    | ms      | % total |
|--------------------------|---------|---------|
| fetchAll                 | 40,221  | 17.3%   |
| refreshProducts          | 161,814 | 69.8% 🆕|
| recordPriceChanges       | 24,806  | 10.7%   |
| rebuildProductTypeCounts | 1,296   | 0.6%    |
| Autres (lock, diff, etc) | 3,833   | 1.6%    |
| TOTAL                    | 231,970 | 100%    |

### Nouveau bottleneck identifié (à surveiller)

🆕 refreshProducts: 162s sur grosse journée de changes (~100 batches Turso)
- Pas un problème aujourd'hui (sous 300s)
- Risque: nightly avec CSV lent (80s) + grosse journée changes (162s) +
  autres (30s) = 272s. Marge 30s seulement.
- Optimisation possible si récurrent: chunking + checkpoint comme Phase 2

### Decision tree pour demain 06:00 UTC

**Scénario A** (probable, ~70%): cron completed en <300s
→ Bug C définitivement résolu, on peut attaquer Bug A (scheduled posts)

**Scénario B** (~20%): cron failed avec "CSV fetch exceeded 240s"
→ Plan B pré-cache CSV (GitHub Actions ou Vercel background)
→ Documenté, mais pas implémenté tant que pas confirmé nécessaire

**Scénario C** (~10%): cron failed avec timeout autre phase
→ Probablement refreshProducts sur grosse journée
→ Optimisation chunking + checkpoint pattern

### État final session

- v0.1.14.3 en prod
- 147/147 tests
- Sync_runs ont maintenant des timings par phase visibles dans Vercel logs
- Aucun zombie
- Plus jamais de SIGKILL silencieux — diagnostic explicite désormais

### Bugs toujours en attente (P1/P2)

**Bug A — Scheduled posts ne fire pas (P1, 1-2h)**
**Bug B — UX published posts (P2, 1h)**
**Bug C — Phase 1 nightly** : 75% probabilité résolu, 25% nécessite Plan B selon demain matin

### Commande pour reprendre

cd ~/.gstack/projects/aosom-sync
git checkout main && git pull origin main --ff-only

Vérifier d'abord le cron de demain matin:
SELECT id, started_at, completed_at, status, total_products,
       substr(COALESCE(error_messages, ''), 1, 200) as err,
       CAST((julianday(COALESCE(completed_at, 'now')) - julianday(started_at)) * 86400 AS INTEGER) as duration_s
FROM sync_runs WHERE started_at > datetime('now', '-24 hours')
ORDER BY started_at DESC;

Selon le résultat: Scénario A → Bug A, Scénario B → Plan B, Scénario C →
optimisation refreshProducts.

---
## UPDATE 24 avril milieu de journée — Option α shipped MAIS fix incomplet

### Ce qui est shipped (PR #28, v0.1.14.0 en prod)

✅ Option α (diff-before-upsert) architecture:
   - getProductsSnapshot (SELECT 23 fields vs 8.8s SELECT *)
   - diffProductsLight pur O(n)
   - refreshProducts sur subset changé seulement
   - rebuildProductTypeCounts batché (77s → 6.7s)
   - Promise.all(fetch CSV, snapshot) parallèle
   - 142/142 tests verts
   - Red Team review: trouvé 10 fields manquants dans hasChanged, fixés

✅ Bench local Run 1: 37 min (rattrapage 8274 rows, 14j backlog)
✅ Bench local Run 2: 109s (0 writes, DB alignée)
✅ Script scripts/force-push-shopify.ts (précédente session)

### Ce qui NE fonctionne PAS encore

🚨 Trigger Phase 1 manuel en prod → FUNCTION_INVOCATION_TIMEOUT (504 à 300s)

**Diagnostic incomplet:**
- Hypothèse "fetchAosomCatalog = 88s" NON PROUVÉE (inférence sur timestamp,
  pas sur label de phase Pino)
- 160s manquants non expliqués
- Les logs Vercel Pino sont tronqués, inaccessibles via API
- Bench local ≠ prod (réseau WSL2 ≠ Vercel us-east-1)

**Hypothèses ouvertes à vérifier avec instrumentation:**
- fetchAosomCatalog retry 2× à 60s timeout = 195s worst case possible
- refreshProducts avec N rows inconnu (0 à 2000+ selon drift depuis 20 avril)
- recordPriceChanges N+1 (déjà identifié au bench Run 1 comme 218s sur 7656 rows)
- rebuildProductTypeCounts (même s'il est batché maintenant)

### Plan prochaine session — OBLIGATOIRE avant re-fix

**Principe non-négociable: NO MORE HYPOTHESIS-BASED FIXES.**

On a épuisé les cycles "hypothèse → fix → échec" (libsql, payload, multi-row,
maintenant Option α seul). La prochaine session DOIT commencer par
l'instrumentation avant tout changement de code.

**Étape A — Instrumentation Pino obligatoire (~15 min)**

Dans src/jobs/job1-sync.ts, wrap chaque phase avec:
  const t0 = Date.now();
  // phase X
  log(`Phase X terminée`, { duration_ms: Date.now() - t0 });

Phases à instrumenter:
1. clearStaleLock
2. createSyncRun
3. fetchAosomCatalog (+ nombre de retries si applicable)
4. getProductsSnapshot (+ count de rows récupérées)
5. diffProductsLight (+ toInsert/toUpdate/unchanged/removed counts)
6. detectChanges (+ count de diffs trouvés)
7. refreshProducts (+ count de rows écrites)
8. rebuildProductTypeCounts
9. recordPriceChanges (+ count d'entrées)
10. completeSyncRun

Format logs structuré JSON pour facilité d'analyse en post-mortem.
Garantie de préservation: AUCUN changement de logique métier. Uniquement
ajout de logs avant/après.

**Étape B — Deploy instrumentation + trigger manuel**

Commit "observability: add per-phase timing logs to Phase 1 sync"
Push, merge, deploy. Trigger Phase 1 manuel. Cette fois, les logs Vercel
vont montrer le breakdown RÉEL par phase.

**Étape C — Fix basé sur les VRAIES données**

Selon ce que les logs révèlent:
- Si fetch 88s+ confirmé: pré-cache ou cascade de crons
- Si refreshProducts dépasse attentes: investigate pourquoi (volume?
  connection pool?)
- Si recordPriceChanges gros: batcher comme on a fait pour product_type_counts
- Si autre chose qu'on n'a pas anticipé: on saura enfin quoi fixer

**Étape D — Validation finale**

Re-trigger manuel, confirmer duration <90s et status=completed.

### Commandes pour reprendre

```bash
cd ~/.gstack/projects/aosom-sync
git checkout main && git pull origin main --ff-only
cat docs/NEXT-SESSION.md | head -100
```

Dire à Claude: "Reprise aosom-sync. Je veux attaquer Phase 1 prod timeout
via instrumentation. Commence par Étape A (wrap chaque phase avec logs
Pino structurés)."

### Bugs toujours en attente (P1/P2)

**Bug A — Scheduled posts ne fire pas (P1, 1-2h)**
Drafts scheduled (ex: 83B-353V00GN) jamais publiés par le cron.
Investigation Job 4 cron logic.

**Bug B — UX published posts (P2, 1h)**
Boutons Edit/Reject restent cliquables après publication. Pas de badge
"Published at" visible. UI polish.

---
## UPDATE 24 avril (fin de journée) — PR #28 mergée, prod toujours timeout

### ❌ Validation prod Phase 1 — ÉCHEC

Trigger manuel Phase 1 à 18:12:57 UTC → FUNCTION_INVOCATION_TIMEOUT (504) à ~300s.
Le fix diff-before-upsert (v0.1.14.0) résout les ÉCRITURES DB mais pas le bottleneck réel.

**Root cause finale (réévaluation) :**
`fetchAosomCatalog()` depuis Vercel us-east-1 prend 88s+ à lui seul (visible dans logs prod).
Même avec 0 écriture, si le CSV download prend 200s, le timeout est inévitable à 300s.

**Timeline logs :**
- 18:12:57.809Z → job start ("Fetch CSV Aosom + snapshot DB...")
- 18:14:25.819Z → 2ème log interne (88s, Promise.all encore en vol)
- ~18:17:57Z → Vercel kill (300s), zombie status=running, total_products=0

**Zombie actuel :** id `0eef94f1-fb34-4c8b-9e08-cecfbdbd20c3` — sera auto-nettoyé par
`clearStaleLockIfNeeded` au prochain trigger (>30min stale).

**Prochaine priorité P0 :** Séparer le téléchargement CSV du processing.
Options :
1. Mesure d'abord — logger `fetchAosomCatalog()` duration exacte en prod
2. Pré-cache CSV — cron léger stocke le CSV (R2 / Turso), Phase 1 lit depuis cache
3. Fallback local — `npx tsx --env-file=.env.local -e "import {runSync} from './src/jobs/job1-sync'; runSync({shopifyPush:false})"`

---
## UPDATE 24 avril — 3 wins business shipped

### Wins de la session

1. ✅ PR #26 (social cron Anthropic timeout) — mergée + validée en prod
   Draft #290 créé automatiquement à 00:22:25 UTC le 23 avril.

2. ✅ PR #27 (force-push Shopify drift recovery) — mergée + exécutée
   - Script: scripts/force-push-shopify.ts (permanent, re-lançable)
   - Dry-run: 18 price diffs détectés sur 47 produits Shopify matched
   - --apply: 18/18 success, 0/18 failed
   - Rapport: scripts/reports/force-push-2026-04-24T01-32-30.json
   - Tests: 120/120 (vs 108 baseline début de session)
   - Version: 0.1.13.0

3. ✅ Bug C (Phase 1 timeout) — Option α implémentée + benchée
   - PR #28 (fix/phase1-diff-before-upsert) — prête à merger
   - Bench Run 1 (rattrapage 14j): 8274 rows écrites, 0 crash, 0 corruption
   - Bench Run 2 (nominal): 109s total (0 writes, DB alignée) ✅ ACCEPTABLE
   - Tests: 137/137
   - Version: 0.1.14.0
   - Nouveau bottleneck découvert: P6 recordPriceChanges N+1 (voir ci-dessous)

4. ✅ Bug destructif latent désamorcé dans diff-engine.ts
   (retrait comparaison description — voir NEXT-SESSION.md précédent)

### Bugs identifiés pour sessions futures

**Bug A — Scheduled posts ne fire pas (P1)**
Scheduled drafts (ex: 83B-353V00GN pour 23/04/2026 19:25 UTC) jamais publiés.
Le cron /api/cron/social fait stock_highlight mais ne processe pas
les scheduled_at de facebook_drafts.

Hypothèse: pas de worker qui compare scheduled_at vs NOW() et fire publish.
Branche: fix/scheduled-posts-not-firing
Estimation: 1-2h

**Bug B — UX post-publication insuffisant (P2)**
Posts "published" ne se distinguent pas visuellement des "draft":
- Boutons Edit/Photos/Reject/Delete restent cliquables
- Pas de timestamp "Posted at HH:MM on FB/IG" visible
- Pas de badge "✅ Published" proéminent

Branche: feat/social-published-state-ux
Estimation: 1h

**Bug C — Turso Phase 1 timeout → ✅ RÉSOLU (PR #28, v0.1.14.0)**
Option α implémentée. Bench Run 2 (nominal): 109s ✅ ACCEPTABLE.
Merger PR #28 + trigger Phase 1 manuel en prod pour validation finale.

**Bug D — recordPriceChanges N+1 (P2, perf future)**
Découvert via bench Run 1: 7656 history entries × ~28ms/entry = 218s.
Même pattern que rebuildProductTypeCounts (résolu par db.batch()).
Fix: remplacer la boucle séquentielle dans `recordPriceChanges()` par
`db.batch([...inserts], "write")`.
Fichier: src/lib/database.ts (chercher `recordPriceChanges`).
Estimation: 30 min. Impact: Phase 1 daily workload nominal non affecté
(typiquement ~50-300 rows changées/jour = 50-300 history entries, ~7s max).
Seulement visible si backlog multi-jours (ex: redéploiement après panne).

### État prod

- Phase 1 cron: cassé (timeout chaque nuit) — PR #28 à merger pour fix
- Phase 2 cron: 3 tentatives par matin, 0 complétée depuis v0.1.10.0
- Social cron: opérationnel (draft#290 créé)
- Shopify prices: 47 produits à jour au 24 avril 01:32 UTC
- Remaining drift: 27 produits en DB sans shopify_product_id (pas importés)

### Plan prochaine session (ordre recommandé)

1. Merger PR #28 + trigger Phase 1 prod + valider cron le lendemain matin
2. Bug A (scheduled posts) — 1-2h, fixe une fonctionnalité visible cassée
3. Bug B (UX published) — 1h, polish
4. Bug D (recordPriceChanges N+1) — 30min, perf optionnelle

### Commande pour reprendre

cd ~/.gstack/projects/aosom-sync
git checkout main && git pull origin main --ff-only
cat docs/NEXT-SESSION.md | head -80

---

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
