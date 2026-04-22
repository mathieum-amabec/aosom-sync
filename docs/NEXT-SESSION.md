# Next session — 22 avril 2026 (en cours)

## UPDATE 23 avril (session reprise)

### Révision de l'hypothèse Turso

Finding critique après reprise: le cron Phase 1 du **20 avril 06:25 UTC** a 
complété en **235s AVEC le fetch Shopify** (v0.1.10.0, pré-Fix #2). 

Si le bottleneck `db.batch(100) @ 24s/batch` était structurel, ce run aurait 
timeout AVANT le nôtre (qui faisait moins de travail). Donc l'hypothèse 
"db.batch séquentiel" probablement FAUSSE.

**Hypothèses alternatives plus probables:**
- Dégradation Turso transitoire le soir du 22 avril
- Cold start connection pool (22 avril était 1ère connexion post-deploy, 
  20 avril était dans une série warm de crons successifs)

### Décision: Wait before fix

**On attend le cron 23 avril 06:00 UTC** avant de toucher à TURSO_DATABASE_URL.

Raisons:
1. Action hâtive risque de produire une fausse confirmation ("https:// a fixé" 
   alors que c'était transitoire)
2. Le 20 avril prouve que le système peut compléter avec le code actuel
3. Fix #2 déployé le 22 avril doit faire passer Phase 1 de 235s (avec fetch) 
   à bien moins (sans fetch). Le cron de demain est la vraie mesure.
4. Changement d'infra = perte d'apprentissage sur la vraie cause

### Plan 23 avril matin (à 7-8h Montréal)

Audit du cron 06:00 UTC via:
- SELECT id, started_at, completed_at, status, duration_s FROM sync_runs 
  WHERE started_at > '2026-04-23T05:55:00Z' AND started_at < '2026-04-23T06:10:00Z'
- /api/health public

Arbre de décision:
- duration_s < 120 → transitoire confirmée, on passe au force-push des 74 produits
- duration_s 120-280 → marginal, on observe samedi et dimanche avant conclusion
- duration_s > 300 ou status='failed' → structurel, go Option 1 avec prompt dédié

---

## État actuel

- PR #25 (v0.1.11.0) mergée et déployée en prod
- Fix #1 (createSyncRun avant fetch) ✅ CONFIRMÉ via test manuel
- Fix #2 (skip fetch Shopify Phase 1) ✅ CONFIRMÉ via test manuel  
- Vercel Pro activé, 3 crons actifs
- Meta App Review: credentials validées, en attente de soumission manuelle
- 0 zombie en DB (cleanup effectué)

## Nouveau bottleneck découvert (bloquant)

Phase 1 timeout à 302s. Pas à cause des fixes — à cause d'un NOUVEAU bug révélé:
`refreshProducts()` prend ~24s par batch de 100 produits dans Turso, pour 105 batches total.

### Cause probable (hypothèse forte)

`db.batch(stmts, "write")` via `libsql://` (WebSocket hrana) exécute les 100 statements
SÉQUENTIELLEMENT au lieu d'en faire un vrai batch atomique. Avec ~250ms de latence 
réseau par statement, on obtient 100 × 250ms = ~25s par "batch" — correspond aux 
mesures observées (24s/batch, 5 batches en 120s).

### Fix recommandé: Option 1 (changement d'env var, zéro code)

Changer TURSO_DATABASE_URL:
  - AVANT: libsql://aosom-sync-matmat.aws-us-east-1.turso.io
  - APRÈS: https://aosom-sync-matmat.aws-us-east-1.turso.io

@libsql/client v0.17.2 supporte les deux schemes. `https://` fait du vrai HTTP REST
(équivalent à POST /v2/pipeline avec 100 statements en un body JSON = 1 round-trip).

Gain attendu: refreshProducts passe de >300s à ~5-10s. Phase 1 passe sous 60s.

Risque: les subscriptions/live queries ne marchent pas en HTTP mode. Ce projet 
n'en utilise pas, donc safe.

### Plan d'exécution prochaine session

1. Modifier `.env.local` local: libsql:// → https://
2. Tester `bun run test` (DB tests doivent encore passer)
3. Lancer un script local qui appelle refreshProducts sur un sous-ensemble 
   (ex: 1000 produits du CSV Aosom) pour mesurer le nouveau timing
4. Si gain confirmé (>5× plus rapide), changer l'env var sur Vercel Production
5. Trigger Phase 1 manuel post-deploy pour confirmer en prod
6. Si succès → attendre le cron automatique 06:00 UTC du lendemain

## Options alternatives (si Option 1 ne suffit pas)

- Option 2: `await db.batch(allStmts, "write")` en une seule fois (1 round-trip 
  au lieu de 105). Risque: payload 26MB peut dépasser limites Turso.
- Option 3: Exclure description/short_description du ON CONFLICT DO UPDATE 
  (réduit payload 70%). Ne résout pas le N+1 mais accélère chaque batch.

## Bonus fix indépendant à faire quand on y sera

`rebuildProductTypeCounts` (database.ts:388-391) — 307 `db.execute()` séquentiels 
= ~77s additionnels. Remplacer par `db.batch(allInserts)`. 5 lignes.

## Autres items en attente (par priorité business)

1. Script force-push one-shot pour combler le drift sur les 74 produits Shopify
   importés (exemple connu: 84G-720V00GY DB=$214.99 ≠ Shopify=$179.99)
2. Étape 2 du plan sync: migration + backfill variant IDs en DB (préparation Étape 3)
3. Étape 3 du plan sync: refactor Phase 2 pour lire diffs depuis DB au lieu 
   de fetcher Shopify live
4. Bug Social cron: 0 draft créé le 22 avril à 13:00 UTC (à investiguer)
5. Meta App Review: submission manuelle (business verif + screencast + submit)

## Commandes pour reprendre

```bash
cd ~/.gstack/projects/aosom-sync
git checkout main
git pull origin main --ff-only
git status   # doit être clean
bun run test # sanity: 104+/104+ pass
cat docs/NEXT-SESSION.md
```

## État DB prod au checkpoint

- sync_runs: 0 running (propre)
- Dernier Phase 1 completed réel via cron: 2026-04-20T06:25:21Z
- Dernier Shopify push completed: jamais depuis v0.1.10.0 deploy
- Products count: 10 426
- Version prod: 0.1.11.0
