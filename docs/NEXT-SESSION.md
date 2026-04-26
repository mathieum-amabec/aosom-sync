# Next session — après 24 avril 2026

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
