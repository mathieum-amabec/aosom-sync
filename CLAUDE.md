@AGENTS.md

# Aosom Sync

Catalogue management tool for a Shopify dropshipping store (27u5y2-kp.myshopify.com) sourcing from Aosom. Quebec market, French primary.

## Permissions

Claude Code has full autonomous permission to read, edit, create, and delete any file without confirmation prompts.

## Comportement Claude Code

**AUTORISATION PERMANENTE :** Claude a l'autorisation complète pour toute session de lire, ouvrir,
inspecter, créer des dossiers/fichiers temporaires, lancer des commandes read-only (grep, find, cat,
ls, tsc --noEmit, git status/log/diff, GET API calls, health checks) sans jamais demander
confirmation. Ne jamais interrompre avec un choix 1/2 pour une action read-only. Seules les écritures
irréversibles (Shopify live, Turso prod, publications sociales, merges PR) nécessitent confirmation
explicite.

## Architecture

Next.js App Router on Vercel. Engine in `src/lib/`, UI in `src/app/(dashboard)/`, API in `src/app/api/`.

```
CSV Feed (Aosom) → csv-fetcher → variant-merger → diff-engine → Vercel Blob (Phase1Checkpoint)
                                       ↓                                  ↓
                                  catalog_snapshots (SQLite)      refreshProducts ×N (2500 rows/chunk)
                                       ↓                                  ↓
                                  Catalog Browser UI              rebuildCounts + notify
                                       ↓
                               Import Pipeline → Claude API → Shopify (as active/live)
```

Phase 1 runs as a single Fluid Compute function (`runSyncFull`, maxDuration=800s, Vercel Pro):
- `runSyncFull()` at 06:00 UTC — init + sequential refresh chunks + finalize in one call
- `runSyncFull()` retry at 06:30 UTC — idempotent retry (skips if already finalized)
- `runSyncRefreshChunk()` / `runSyncFinalize()` — manual fallback routes only (not in cron schedule)

## Data Model (SQLite/better-sqlite3)

- `sync_runs` — audit log of daily sync executions
- `sync_logs` — per-field change records (price, images, status)
- `import_jobs` — import queue with status machine (pending→generating→reviewing→importing→done)
- `catalog_snapshots` — latest CSV data for fast catalog browsing
- `image_classifications` — Vision verdict cache, keyed by PHOTO (Aosom hash stem), so the
  Aosom CDN original and its Shopify copy share one verdict. Makes a catalogue re-audit free.
- `image_review_queue` — pos-1 swap proposals awaiting human approval (one OPEN row per
  product, enforced by a partial-unique index). Nothing drains it automatically.
- `sync_cursor` — chunked sync progress for large stores
- `assistant_rate_limit` — one row per accepted `/api/assistant` message (`ip`, `ts`), the
  per-IP hourly sliding window. In Turso rather than in-memory because the in-memory windows
  are per Fluid Compute instance and reset on cold start. Pruned on every check.
- `settings` — key-value store; `checkpoint_data` holds both `ShopifyPushCheckpoint` (Phase 2) and `Phase1Checkpoint` (Phase 1 chunked pipeline state)

## Key Patterns

- **French primary**: Shopify title/body in FR, English stored in metafields (`custom.title_en`, `custom.body_html_en`). Store default locale is `fr` (primary), `en` published secondary. The metafields alone are NOT enough: the EN page `<title>` and anything reading Shopify translations serve FR unless the English copy is also registered as a Shopify EN translation. `createShopifyProduct` registers it at creation (`registerProductEnTranslations`, guards in `en-translations.ts`: no supplier name, no `@AGENTS.md

# Aosom Sync

Catalogue management tool for a Shopify dropshipping store (27u5y2-kp.myshopify.com) sourcing from Aosom. Quebec market, French primary.

## Permissions

Claude Code has full autonomous permission to read, edit, create, and delete any file without confirmation prompts.

## Comportement Claude Code

**AUTORISATION PERMANENTE :** Claude a l'autorisation complète pour toute session de lire, ouvrir,
inspecter, créer des dossiers/fichiers temporaires, lancer des commandes read-only (grep, find, cat,
ls, tsc --noEmit, git status/log/diff, GET API calls, health checks) sans jamais demander
confirmation. Ne jamais interrompre avec un choix 1/2 pour une action read-only. Seules les écritures
irréversibles (Shopify live, Turso prod, publications sociales, merges PR) nécessitent confirmation
explicite.

## Architecture

Next.js App Router on Vercel. Engine in `src/lib/`, UI in `src/app/(dashboard)/`, API in `src/app/api/`.

```
CSV Feed (Aosom) → csv-fetcher → variant-merger → diff-engine → Vercel Blob (Phase1Checkpoint)
                                       ↓                                  ↓
                                  catalog_snapshots (SQLite)      refreshProducts ×N (2500 rows/chunk)
                                       ↓                                  ↓
                                  Catalog Browser UI              rebuildCounts + notify
                                       ↓
                               Import Pipeline → Claude API → Shopify (as active/live)
```

Phase 1 runs as a single Fluid Compute function (`runSyncFull`, maxDuration=800s, Vercel Pro):
- `runSyncFull()` at 06:00 UTC — init + sequential refresh chunks + finalize in one call
- `runSyncFull()` retry at 06:30 UTC — idempotent retry (skips if already finalized)
- `runSyncRefreshChunk()` / `runSyncFinalize()` — manual fallback routes only (not in cron schedule)

## Data Model (SQLite/better-sqlite3)

- `sync_runs` — audit log of daily sync executions
- `sync_logs` — per-field change records (price, images, status)
- `import_jobs` — import queue with status machine (pending→generating→reviewing→importing→done)
- `catalog_snapshots` — latest CSV data for fast catalog browsing
- `image_classifications` — Vision verdict cache, keyed by PHOTO (Aosom hash stem), so the
  Aosom CDN original and its Shopify copy share one verdict. Makes a catalogue re-audit free.
- `image_review_queue` — pos-1 swap proposals awaiting human approval (one OPEN row per
  product, enforced by a partial-unique index). Nothing drains it automatically.
- `sync_cursor` — chunked sync progress for large stores
- `assistant_rate_limit` — one row per accepted `/api/assistant` message (`ip`, `ts`), the
  per-IP hourly sliding window. In Turso rather than in-memory because the in-memory windows
  are per Fluid Compute instance and reset on cold start. Pruned on every check.
- `settings` — key-value store; `checkpoint_data` holds both `ShopifyPushCheckpoint` (Phase 2) and `Phase1Checkpoint` (Phase 1 chunked pipeline state)

## Key Patterns

- **French primary**: Shopify title/body in FR,  price, no French). Backfill: `scripts/register-en-product-translations.mts` (dry-run default, `--apply`; run 2026-09-28 on 1445 products).
- **`body_html` has ONE writer**: `createShopifyProduct`, at import (`content.descriptionFr`). ⚠️ The daily sync must **never** push the feed's `description` — that field is raw ENGLISH supplier copy, while `body_html` is curated FRENCH. Comparing them is comparing two languages, so the check is true on every run and the push overwrites French with English. That is exactly what happened from b497260 (2026-04-05) to v0.5.92.3: ~5-7 products/day silently flipped to English, reaching 679 of 1382 active products (49%) with 518 naming "Aosom" in customer copy (552 counting every forbidden supplier name). Re-measure with `scripts/audit-description-language.mjs`. `diff-engine.ts` no longer emits a `description` change and `applyToShopify` no longer sets `productUpdates.bodyHtml`; both are locked by regression tests. The feed stays authoritative for price, stock, images and tags only.
- **`last_seen_at` = "seen in the feed", never "changed"**: `markSkusSeen()` stamps **every** SKU in the Aosom feed during Phase 1 init, changed or not. Before v0.5.92.5 the only writer was `refreshProducts`, which runs on changed rows only — so on a day with zero changes nothing was stamped, `getAllProductsAsAosom()` (`WHERE last_seen_at >= today`) returned 0, and `computeDiffs` read that as "Aosom withdrew all 1,382 active products" and queued 1,349 archives. Phase 2 unpublished 30 live products on 2026-09-12 before it was caught. Anything that writes or reads this column must keep presence and change as separate facts.
- **Two sync circuit breakers** (`sync-guards.ts`): `assertFeedPlausible` makes Phase 1 throw *before any write* on an empty feed or one under 50% of the last good run, so the previous checkpoint survives and the run is recorded `failed` rather than silently succeeding. `guardMassArchive` makes Phase 2 drop archive diffs above `max(20, 5% of active)` in one computed pass (measured on the whole diff set, not the 10-diff chunk — per-chunk the incident looked normal) while letting price/stock/image/tag diffs through untouched. Since v0.5.92.6 **both paths** carry them: the cron (`runSyncInit` / `runShopifyPush`) *and* the manual dashboard trigger (`runSync`, via `POST /api/sync/trigger`), which also gained the same 10-diff per-run cap — it previously pushed every diff in one pass. `runSync` does not touch `shopify_push_checkpoint` (that belongs to the cron), so its deferred diffs drain at the next 08:00 UTC Phase 2. ⚠️ Any new Shopify write path must be routed through these two guards; presence of the import alone is not protection, the call has to sit *before* the first write.
- **The CSV cache can go stale silently** — it did, for two days. `fetchAosomCatalog` now refuses a blob older than 26 h and falls through to the live CDN; if that fails too it throws, which is wanted. The trigger was `csv-precache`'s hardcoded `MIN_CSV_ROWS = 8_000` against a catalogue that drifted to ~7,960: every download was rejected and the blob froze. That floor is now 4,000 plus a relative check (≥70% of the last cached size). ⚠️ Never set a fixed feed-size floor near the live value.
- **COLOR_MAP**: 2-letter SKU suffix → French color name (e.g., BK→Noir, GY→Gris). See `variant-merger.ts`
- **PSIN grouping**: Aosom's Parent SKU groups color/size variants. Fallback: parseSku()
- **Dropship**: `createShopifyProduct` still creates variants with `inventory_management: null` — untracked, stock lives only in the catalog snapshot. ⚠️ An untracked variant is **sellable forever**: Shopify ignores its `inventory_quantity` and `inventory_policy: deny` has no effect, so `setInventoryLevel(0)` on one is a silent no-op. Since v0.5.72.0 `runInventorySweep` (`inventory-sweep.ts`) switches tracking ON and then writes 0 for any untracked variant the feed marks sold out, so the catalog is migrating to tracked one sold-out variant at a time (the cron detail reports `tracking+=N`). Any code that filters variants on `tracked` skips exactly the ones that can oversell.
- **Active imports**: New products are auto-published as `active` (live) on import — `createShopifyProduct` sets `status: "active"` (see `shopify-client.ts`; switched from draft→active in commit beb00b4, 2026-06-07). No manual-review draft step. Caveat: `status:"active"` only auto-publishes to the Online Store **at creation** — flipping an existing product draft→active does NOT publish it, and legacy pre-beb00b4 draft imports never activated stay hidden. `runPublishReconcile` (`publish-reconcile.ts`, route `GET /api/cron/publish-reconcile`, dry-run unless `?apply=1`) closes that gap: it publishes (`publishShopifyProduct`, REST `published:true`) every imported product sellable in today's Aosom CSV that sits unpublished — excluding `auto-drafted` (intentional aosom-sync drafts) and `exclude-stale`, guarded by the same `assertFeedComplete` (FEED_MIN_COVERAGE 0.70), capped at 67/run. It is the inverse of `stale-catalog` and is NOT on any cron schedule (operator-triggered only).
- **Sold out / out of season ⇒ DRAFT, and back automatically** (`sold-out-hide.ts`, cron `/api/cron/sold-out-hide`). Sold out = `auto-drafted` (shared with stock-check, whose restock path reactivates it); out of season (Halloween = `product_type` word « Halloween », window `settings.seasonal_windows`, default 09-01 → 11-01) = `hors-saison` WITHOUT `auto-drafted`, lifted only by this job at the season start. `hors-saison` is the job's OWN marker: it is only added when the job drafts an ACTIVE product, or to an automatic `auto-drafted` draft; an operator's draft (no `auto-drafted`) is never marked, so it is never published at a season start. Never strip either tag by hand without also fixing stock/season, or the next run re-drafts. A product entirely absent from the feed is left to removed-catalog/stale-catalog. The ad feeds read the same `settings.seasonal_windows` (`loadSeasonalRules`).
  - **Keep a Halloween (seasonal) product live out of season:** tag it `exclude-stale` in the Shopify admin, then set it back to active. Without that tag the job re-drafts it at its next run (10:20 / 16:20 / 22:20 UTC). The same tag keeps a sold-out product live. To move the whole season instead, edit `settings.seasonal_windows` (no deploy), e.g. `{"halloween":{"start":"08-15","end":"11-03"}}`.
- **[BRAND NAME]**: Aosom HTML descriptions contain this placeholder. Replaced with actual brand before Claude processing
- **Product copy provider** (`CONTENT_PROVIDER`, `content-provider.ts`): who writes the FIRST draft of a listing in `generateProductContent` — the ONE function every import goes through (import pipeline / `POST /api/import/generate`, the backfill and migrate scripts; Costway will reuse it). **Gemini is the default** whenever `GEMINI_API_KEY` is set; a clone without the key falls back to Claude; `CONTENT_PROVIDER=anthropic` (or `LLM_PROVIDER=anthropic`) forces the old Haiku → Sonnet chain. Gemini chain: **Flash-Lite → Gemini 3.8 Flash** (`GEMINI_CONTENT_MODEL` / `GEMINI_CONTENT_STRONG_MODEL`), no Claude in the path. Only a validation failure moves down the chain: an API or budget error propagates (no silent paid fallback). Same prompt and validators whatever model wrote the draft. Basis: the 2026-10 A/B on 30 products — Gemini ≈3x cheaper ($0.0021 vs $0.0065/product) and ≈3x faster, 30/30 valid, equal-or-better on a blind read.
  - **Guardrails** (`content-guards.ts`, applied to whichever model wrote it): titles are *repaired* in code — inch/foot/lb → metric ("77 x 69 po" → "196 x 175 cm"), trailing "— colour" removed (inline colour only when the product has several colours), capped at 10 words (a dimension like "3 x 4 m" counts as one word; never cut inside it, never end on "avec"/"de"). The body is only *detected*: imperial values with no metric value beside them ("Hauteur de 38,25 po"; dual units like "30 kg (66 lb)" are fine), accent-less French ("bebe"), fewer than 6 tags → ONE same-tier corrective retry (never escalates to the paid tier; a failure on the retry propagates as itself), then the draft is kept with a warning.
- **LLM models — Gemini first** (`llm-models.ts`; since 2026-10-03). Callers ask `llmModel("lite" | "strong")` instead of naming a model. `budgetedCreate` serves any `gemini-*` model with Google and returns the Anthropic-shaped Message, so call sites are unchanged. Gemini is on whenever `GEMINI_API_KEY` is set; without it (bare clone, unit tests) every tier falls back to `CLAUDE.MODEL_BATCH`. `LLM_PROVIDER=anthropic` is the one-switch rollback; `GEMINI_LITE_MODEL` / `GEMINI_STRONG_MODEL` override the ids.
  - **`lite` = `gemini-3.5-flash-lite`** ($0.30/$2.50 per M): short copy (social captions, content templates, slogans, Google Business posts) and vision (`classifyProductImage`). Equal or better than Haiku in the 2026-10 blind tests, ~3x cheaper.
  - **`strong` = `gemini-3.8-flash`** ($0.75/$3.75 through 2026-12-31, then $1.50/$7.50): blogs and the blog judge, guide drafts, the guide judges (fact-check caught 40/40 planted errors; Flash-Lite missed 7 and scored quality far too leniently — never use it as a judge), Reel/video copy (Flash-Lite drops the "$" from prices).
  - **Gemini quirks handled centrally in `budgetedCreate`:** `gemini-3.8-flash` rejects `thinkingLevel: "minimal"` (400), so Flash-Lite uses minimal and everything else `low` (`GEMINI_THINKING_LEVEL` overrides, never to minimal on an unsupported model); thought tokens are drawn from the answer's budget, so `maxOutputTokens` gets +2,500 headroom when the model thinks (a Reel caption and a vision JSON were cut mid-sentence without it).
  - **Still on Claude on purpose:** guide REVISION after a judge's notes (`CLAUDE.MODEL` = Sonnet 4.6: 84.2 vs 78.8 for 3.8 Flash in the test), `kling-client.ts` (`/api/videos/generate`, a leftover — Haiku won the test), and one-off scripts that call `client.messages.create` directly. `CLAUDE.MODEL_ASSISTANT` is unused now (the storefront assistant runs on Gemini via `GEMINI.MODEL_ASSISTANT`).
  - **Deterministic guards added from the tests:** blog articles are rejected on foreign-script characters (Flash-Lite once printed "гарonie") and retried once under 550 words (`articleProblems`); `~~strike~~` is stripped from captions; Google Business posts that say "boutique/magasin" or invent urgency are auto-rejected (`findGbpFalseClaim`; the store is online-only); `normalizeLine` keeps in-word apostrophes (it printed "SENNUIE"). Known gap: no deterministic price/percentage check on guide copy — the LLM fact-check is the only barrier.
- **`/api/assistant` never returns a limit as an error.** Every tripped limit answers
  `success: true` with `data.reply` + `data.products: []` so the widget renders a hand-off
  card: hourly quota → **429**, rapid-fire → **200**, daily pool exhausted → **200** (was 503
  before v0.5.74.0). ⚠️ A limit response is therefore indistinguishable from a genuine
  zero-result answer by `products.length` alone — **anything probing this endpoint must branch
  on `data.limitReached` / `data.reason`**, never on an empty `products` array or on the status.

## Image principale (pos-1) — garde-fou anti-overlay

⚠️ **Une image principale ne doit JAMAIS porter de texte marketing ou de cotes incrustées**
(mesures, flèches, callouts, slogans, badges). Le texte *diégétique* — imprimé sur le produit
lui-même ou présent naturellement dans le décor — ne compte pas. C'est la règle que le flux
Aosom viole le plus souvent : ses infographies de dimensions arrivent tôt dans la galerie et
finissent en pos-1.

Trois pièces, **un seul moteur de verdict** (`image-compliance-audit.ts`) pour que l'audit de
masse et le garde-fou quotidien ne puissent pas diverger sur la définition de « propre » :

| Pièce | Rôle |
|---|---|
| `vision-classifier.ts` | 1 image → `{compliant, reason}`. Prompt strict (`STRICT_OVERLAY_PROMPT`), `CLAUDE.MODEL_BATCH`. |
| `image-compliance-audit.ts` | `auditProductPos1()` — classe pos-1, puis cherche la 1ʳᵉ alternative propre. **N'écrit jamais sur Shopify.** |
| `image-compliance.ts` | `runImageCompliance()` — le passage quotidien, appelé en fin de sync (`job1-sync.ts`). |

### Mode de fonctionnement — réglage `image_compliance_mode` (settings, pas de déploiement)

- **`hybrid` (défaut depuis v0.5.92.0, actif en prod)** — un cas **évident** s'applique tout
  seul sur Shopify ; un cas **ambigu** part dans `image_review_queue` pour décision humaine.
  C'est ce qui empêche la file de regonfler à 312 sans pour autant laisser la machine trancher
  un choix éditorial.
  ⚠️ **Il coûte plus cher en appels Vision que les autres** : distinguer évident d'ambigu
  oblige à scanner **tout** le jeu d'images (`scanAllAlternatives`) au lieu de s'arrêter à la
  première image propre.
- **`queue`** — toute proposition part dans `image_review_queue`, **rien n'est écrit sur
  Shopify**. Un humain tranche sur `/images`. C'est le mode sous lequel le grand nettoyage du
  catalogue a tourné.
- **`auto`** — bascule immédiate (comportement historique, celui des 141 swaps manuels), sans
  aucune distinction évident/ambigu.
- **`off`** — no-op.

`POST /api/images/review {id, action:"approve"|"reject"}` reste le seul chemin **humain** vers
une écriture Shopify. Depuis v0.5.92.0 il sait aussi **téléverser** une image du flux
(`uploadProductImageToFirstPosition`) au lieu de refuser en 422 ; l'id Shopify obtenu est
réécrit sur la ligne de file, donc un second passage réordonne au lieu de téléverser un doublon.

#### La règle évident vs ambigu (`classifySwapDecision`)

La question n'est **pas** « n'y a-t-il qu'une seule image propre ? » mais « **le gagnant est-il
unique dans sa catégorie ?** ». Un jeu avec 1 lifestyle et 4 packshots n'a rien d'un pile ou
face : la préférence codée lifestyle > fond blanc désigne un gagnant, et aucun humain ne ferait
mieux. Ce que la préférence ne peut PAS départager, c'est une égalité **à l'intérieur** d'une
catégorie.

| Jeu d'images propres | Décision |
|---|---|
| 1 seule image propre, peu importe le fond | **évident** → appliqué |
| 1 lifestyle + N fonds blancs | **évident** → le lifestyle est appliqué |
| 2+ lifestyle | **ambigu** → file |
| 2+ fonds blancs, aucun lifestyle | **ambigu** → file |
| confiance du modèle < `MIN_AUTO_CONFIDENCE` (0,75) sur le verdict pos-1 **ou** sur l'image proposée | **ambigu** → file |
| aucune image propre | rien à faire — laissé tel quel, loggé |

⚠️ **Une confiance `undefined` n'est PAS une confiance faible.** Le prompt demandait déjà un
`confidence` que le parseur jetait ; il est conservé depuis v0.5.92.0 (colonne
`image_classifications.confidence`). Les 3 127 verdicts antérieurs valent `NULL` = *inconnu*.
Les lire comme « faible » enverrait tout le cache historique à la file.

⚠️ **Une candidate du flux n'est JAMAIS appliquée sans humain, dans aucun mode** — la promouvoir
veut dire *ajouter* une photo à un produit en ligne, bien au-delà de « réordonner ce qui est
déjà là ». `hybrid` la met en file même quand le jeu est par ailleurs évident.

### Ce qu'il faut savoir avant d'y toucher

- **Le jeu d'images = galerie Shopify ∪ flux Aosom.** La galerie n'est PAS un sur-ensemble du
  flux : mesuré, ~3 produits sur 8 ont des photos du flux absentes de Shopify. Une candidate
  venant du flux (`source:"feed"`, `proposedImageId: null`) **exige un téléversement** — elle
  n'est jamais appliquée automatiquement, même en mode `auto`.
- **Cache par « stem ».** `imageUrlStem()` réduit l'URL Aosom, la copie Shopify (suffixe
  `_<uuid>` à l'ingestion) et le redimensionnement `_WxH` à la même identité de photo. Un
  re-passage complet sur le catalogue coûte donc ~0 appel (`image_classifications`).
- **Un échec de classification n'est JAMAIS lu comme « non conforme ».** Un verdict manquant
  laisse le produit non estampillé (`image_checked_at` reste NULL) pour un nouvel essai. Le
  sens d'erreur sûr, c'est rater une correction, jamais proposer un mauvais swap.
- **Pool LLM `maintenance`.** Un audit complet (~2 500 appels Vision) représente ~2 jours du
  plafond `batch` entier et affamerait imports/blog/social. `ClassifyOptions.maintenance`
  facture au pool **`maintenance`** : non plafonné (`LLM_MAINTENANCE_DAILY_BUDGET` pour le
  borner) mais **compté et affiché** au tableau de bord. ⚠️ **Scripts seulement** — jamais
  depuis une route ni un cron.

  📌 **Son compteur a affiché 0 pendant deux jours et ce n'était PAS un bug** (enquête du
  2026-09-11). L'audit des 1730 produits s'est terminé à 20:43 ; le commit qui crée le pool a
  atterri à 20:55 — 12 minutes plus tard. Tout l'audit a donc été facturé au pool `batch`, ce
  qui est exactement pourquoi il a crevé le plafond de 1,3 M, bloqué imports/blog/social, et dû
  être remis à zéro à la main en pleine course (`.tmp-imgaudit/restore.mjs`). Le pool était le
  REMÈDE, pas le coupable : il n'avait simplement jamais servi un appel. Vérifié en prod le jour
  même — un vrai appel Vision facturé `maintenance` incrémente bien `daily_llm_budget`
  (+929 tokens). Depuis, un compteur cassé ne ressemble plus à un compteur vide :
  `budgetedCreate` journalise `UNRECORDED SPEND` (pool + nombre de tokens + cause) au lieu
  d'avaler l'erreur dans un `catch` vide.
- **512px suffit.** 952 tokens/appel contre 1961 à 1024px, 97,9 % d'accord sur 48 images. La
  seule divergence mesurée était un overlay *manqué* (petits caractères) — le bon sens d'erreur.
- **Le classificateur Vision est BINAIRE** (`{compliant, reason}`) : overlay marketing ou pas.
  Il ne sait pas distinguer lifestyle et fond blanc — son prompt le lui interdit explicitement
  (« Ne juge PAS la qualité, le fond, ni la mise en scène »). Une photo packshot propre est donc
  **déjà** une remplaçante éligible depuis le premier jour, au même titre qu'un lifestyle : le
  moteur retient la première image PROPRE, quelle qu'elle soit. Mesuré sur la file actuelle :
  24 des 312 propositions en attente sont des fonds blancs.
- **Priorité lifestyle > fond blanc** (v0.5.91.0). Entre deux images propres, `auditProductPos1`
  préfère un lifestyle. C'est un **tri**, jamais un filtre : un packshot propre bat toujours un
  overlay en pos-1. Le rang vient de `classifyImageBackground` (heuristique pixel de
  `variant-merger.ts`, **0 token** — elle télécharge, elle n'appelle pas Claude), `unknown` se
  classe au MILIEU pour qu'un échec de détection ne rétrograde pas une photo sous un fond blanc
  connu. Trier au lieu de collecter toutes les candidates propres garde le coût Vision
  identique : le scan s'arrête toujours à la première image propre. `preferLifestyle: false`
  restaure l'ordre de galerie pur.

### Garde à l'import — la récidive bloquée à la source (v0.5.92.0)

`enforceCleanPrimaryImage` s'exécute dans `queueForImport`, **après** `selectProductImagesAsync`
et **avant** la première écriture du produit. Si la pos-1 candidate porte du texte et qu'une
image propre existe dans le jeu importé, elle est promue **dès la création** — plus aucune
correction après coup pour les nouveaux imports. Les 312 produits de la file étaient tous des
imports partis avec une pos-1 sale, corrigés des semaines plus tard, après que des clients
l'aient vue.

Il **échoue en sécurité dans tous les sens** : erreur de classification, liste vide, ou jeu
entièrement sale ⇒ la liste est renvoyée **inchangée**, le produit s'importe normalement et le
cas est loggé. Un avis sur une image ne bloque jamais un import.

**Coût réel** (mesuré sur le profil de l'audit des 1730, pas estimé) :

| | |
|---|---|
| pos-1 déjà propre | 81,6 % des produits → **1 appel** |
| pos-1 sale, corrigible | 18,0 % → 5,52 appels en moyenne |
| moyenne pondérée | **1,853 appel/produit** |
| imports mesurés | 349/mois (30 j) |
| **coût** | **~616 k tokens/mois ≈ 0,81 $/mois** (0,0023 $/produit) |

⚠️ Facturé au pool **`batch`**, pas `maintenance` : le pool de maintenance est *scripts
seulement* par conception, et l'import est un chemin de production. 616 k tokens/mois ≈ 20 k/jour
contre un plafond `batch` de 1,3 M/jour — 1,6 %. C'est un plafond haut : à l'import les images
sont déjà curées et plafonnées à 8, alors que l'audit scannait jusqu'à 15.

### Audit de masse

`scripts/audit-pos1-compliance.mts` — dry-run sur tout le catalogue, checkpoint JSONL
reprenable, rapport HTML+CSV avec vignettes avant/après. Il **n'a pas de `--apply`**. Ajouter
`--queue` pour remplir `image_review_queue` et trancher ensuite sur `/images`.

```
node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs \
  scripts/audit-pos1-compliance.mts --max-seconds 520 --concurrency 4
```

Audit du **2026-09-11** (1730 produits live) : 1412 conformes · 312 corrigeables ·
6 sans alternative propre · 0 erreur.

**État au 2026-09-12 — la file est vidée.** Les 312 propositions ont été appliquées en lot via
`POST /api/images/review` : 302 réordonnancements + **10 téléversements** depuis le flux. Reste
les 6 sans alternative, inchangés (rien de propre à proposer). Vérifié contre Shopify sur 30
produits : 30/30 conformes.

⚠️ **~16 % des propositions étaient périmées au moment de l'application** : Shopify avait
**ré-ingéré** la photo depuis l'audit, ce qui lui donne un **nouvel `image_id`** — le
`proposed_image_id` stocké renvoyait donc un 404 alors que la photo était toujours dans la
galerie. Corrigé sans un seul appel Vision en re-pointant la ligne via `imageUrlStem` (même
photo ⇒ même verdict). **Toute reprise différée d'une file de propositions doit refaire ce
re-pointage**, sinon une proposition sur six échoue.

## Meta Pixel (two parts — web dataset `214720653324969`)

- **Storefront events (PageView / ViewContent / AddToCart)**: a Shopify **ScriptTag**
  (id `222592598121`) pointing at `/api/pixel/script` (see `src/app/api/pixel/script/route.ts`,
  installed via `/api/pixel/install`). `content_ids` everywhere = `variant.sku` (matches the
  Meta catalog `retailer_id`, e.g. `01-0901` — NOT the numeric `variant.id`).
- **Purchase**: a **Custom Web Pixel installed MANUALLY** in **Shopify Admin → Settings →
  Customer events → Add custom pixel** — there is **no code path or Admin API that creates it**.
  The source of truth for the pasted code is `docs/meta-custom-web-pixel.js`; editing that repo
  file does nothing until an operator pastes it into the pixel manager and re-Saves.
  ScriptTags no longer run on the Checkout-Extensibility Thank-You page, so Purchase cannot live
  in the ScriptTag. The custom pixel runs in Shopify's **lax sandbox** (iframe, no top-frame
  DOM), so it sends Purchase via `fetch()` to `https://www.facebook.com/tr/` (the noscript
  beacon) — NOT the `fbq`/`fbevents.js` SDK, which the sandbox rejects.

## Pinterest Tag (mirrors Meta exactly — env `PINTEREST_TAG_ID`)

A direct mirror of the Meta pixel, same two-part split. `PINTEREST_TAG_ID` (numeric, from
Pinterest Ads Manager → Conversions) gates both halves; unset ⇒ inert no-op script.
`product_id`/`content_ids` everywhere = `variant.sku` = the Pinterest catalog feed `g:id`
(same SKU as the Meta catalog `retailer_id`).

- **Storefront events (page / pagevisit / viewcategory / search / addtocart)**: a Shopify
  **ScriptTag** → `/api/pixel/pinterest-script` (`src/app/api/pixel/pinterest-script/route.ts`,
  loads `s.pinimg.com/ct/core.js` + `pintrk`). Installed/removed by the SAME
  `/api/pixel/install` route as Meta (it now manages BOTH tags — POST installs both, GET
  reports both, DELETE removes both; Meta fields stay top-level, Pinterest under `pinterest`).
  ScriptTag lib: `src/lib/pinterest-pixel.ts`. Route is public (allowlisted in `proxy.ts`).
- **Checkout (conversion)**: a **Custom Web Pixel installed MANUALLY** (Settings → Customer
  events), source of truth `docs/pinterest-custom-web-pixel.js` — replace the `PINTEREST_TAG_ID`
  placeholder with the real numeric id before pasting. Same sandbox constraint as Meta: sends the
  `checkout` event via `fetch()` to `https://ct.pinterest.com/v3/` (the noscript beacon), NOT the
  `pintrk` SDK. `event_id` = checkout token (future Conversions API dedupe key).
- **Prereqs (account-side, before tracking works):** create the Pinterest Tag in Ads Manager to
  get the id, claim the domain, set `PINTEREST_TAG_ID`, then POST `/api/pixel/install`.

## Meta DPA retargeting — "Retargeting DPA — ViewContent + ATC" (campaign ACTIVE; ATC ad set rebuilt 2026-07-19)

⚠️ **Every Meta ad is PAUSED since 2026-11-27** (Mat's decision: the last active campaign `52607877306205`, 140 $/day,
was paused and verified). Relaunch planned in the spring for garden sheds / remises / pergolas. The ad sets below
describe the structure, not what is running today.

Ad account `act_20658834`, catalog `384890002574549`, pixel `214720653324969`. Built by
`scripts/rebuild-dpa-retargeting.mjs` (dry-run default, `--apply`). Replaced the old generic
"Visiteurs 30j" website CA (built on the WRONG pixel `2027065584856990`).

- **Campaign** `52583438066005` (OUTCOME_SALES), ACTIVE.
- **Ad Set 1 — ATC (ADD_TO_CART):** `52584773091805` "ATC 30j — Abandon panier — ADD_TO_CART",
  **ACTIVE**, → CA **AddToCart 30j** `52583438803605`. Rebuilt 2026-07-19; the old ATC set
  `52583438197005` (PURCHASE) is **PAUSED** — it starved at 0 delivery because a ~1000-person
  audience optimized for the rare PURCHASE event can't deliver.
- **Ad Set 2 — "ViewContent — Produit exact vu"** `52583438211605` → CA **ViewContent 30j**
  `52583438060205`, EXCLUDES the ATC CA. Still on PURCHASE (delivers well — 7.7% CTR).
- **Ad Set 3 — "Prospection Broad — Best-sellers"** `52583438225405` → broad 25-65 + Advantage+,
  product set Best-sellers `2218845485631893`.
- Retargeting sets (1 & 2) use the **All Products** set `2891699814486850` so DPA shows the exact
  viewed product; only prospection uses Best-sellers.
- **Conversion-data reality:** the store has only ~10 real confirmed Shopify sales total and the
  pixel was broken before ~July 2026, so Meta has almost no PURCHASE signal — "0 purchases" is
  expected, not a defect. Optimize mid-funnel (ADD_TO_CART) until real purchase volume accrues.
- API gotchas (each cost a failed apply): `product_catalog_id` is rejected in `promoted_object`
  for OUTCOME_SALES (use `product_set_id` only); Meta auto-converts single-format DPA template
  creatives to FORMAT_AUTOMATION CAROUSEL/COLLECTION; do NOT round-trip a GET `?fields=targeting`
  back into a POST (drops geo — rebuild explicitly); **you CANNOT edit the conversion event /
  optimization on a PUBLISHED ad set** (`error_subcode 3260011`) — rebuild from scratch (`POST
  act_.../adsets` with `targeting.targeting_automation.advantage_audience` set explicitly;
  `/copies` fails on >3 objects and on the missing advantage_audience flag), then copy its ads in.

## Google Ads (Shopping) — code ready, credentials NOT provisioned

`src/lib/google-ads-client.ts` (raw REST, no SDK) + `scripts/create-google-shopping-campaign.mts`
(dry-run default, `--apply`, everything created PAUSED). Full walkthrough: `docs/GOOGLE-ADS-SETUP.md`.

- ⚠ **No `GOOGLE_ADS_*` vars exist in `.env.local`.** The dry-run runs without them; `--apply`
  cannot. Developer-token approval is **1–3 business days** and gates every live call.
- **Scope is `.../auth/adwords`, NOT Merchant Center's `.../auth/content`.** A refresh token is
  bound to its consented scopes, so the GMC token **cannot** be reused — it refreshes fine, then
  fails every Ads call.
- Google Ads also needs a `developer-token` header on top of OAuth (no other Google API does).
- **Three platform limits the config can't work around:** smart bidding
  (`MAXIMIZE_CONVERSION_VALUE`) **ignores all bid modifiers and the ad group max CPC**; **sitelinks
  don't render on Shopping ads** (Search only — Shopping promos come from the Merchant Center
  promotions feed); **dynamic remarketing isn't a Shopping feature**, and Meta/Pinterest pixels can
  **never** feed Google audiences (needs Google tag / GA4 / Customer Match).
- Value bidding needs a PURCHASE conversion action — the script's preflight refuses `--apply`
  without one. Seed on `--bidding maximize-clicks` first, then flip in place via `setCampaignBidding`.
- `GOOGLE_ADS_API_VERSION` is pinned in the client; Google sunsets a version ~every 4 months.

## Shopify theme IDs (live vs draft)

⚠️ **Roles MOVE on every publish; names are misleading — trust `themes.json` roles, never the name.**
The tooling no longer hardcodes theme IDs. `scripts/_shopify-lib.mjs` resolves them from
`themes.json` at call time (`getLiveThemeId()` / `getDraftThemeId()` / `getBackupThemeId()`), so
nothing needs re-pointing after a publish. A clone on an old branch may still export the legacy
`LIVE_THEME_ID` constants. Check before trusting them.

As of **2026-09-27** (examples only, IDs rotate; re-read `themes.json`):
- **LIVE / `main` (NEVER write):** `162827305065` "DRAFT — Rabais 2e article 2026-09-26"
- **Pending draft (cart + shipping-copy fixes, not yet published):** `162851749993` "DRAFT — Panier & livraison 2026-09-27"
- **Rollback (previous live):** `162684600425` "DRAFT — Bouton Achat 2026-09-22"
- "Trade v1" and "Trade v2" were deleted on 2026-09-26/27 to free slots.

⚠️ **Theme slots: 20/20 — Shopify's hard cap.** At the cap `themeDuplicate` fails by returning
`newTheme: null` with **no `userErrors`**: a completely silent failure. If duplication appears
to do nothing, **count the themes first** — that is the cause. Freeing one slot made it work on
the next attempt. `141164904553` "Horizon" was deleted for this; it was unpublished, untouched
since March, and `theme_store_id: 2481` means it can be re-downloaded from the Theme Store.

⚠️ **Do NOT publish or branch from `161090928745`.** It was copied from the live on 07-19, but
the live was edited on 07-21, so that draft is missing the **Judge.me app embed**
(`config/settings_data.json`) and an **app section plus several block settings** on the product
page (`templates/product.json`). Publishing it silently reverts them. Caught by an asset
checksum diff on 2026-08-07, before publishing.

**Always diff before publishing.** A draft is a point-in-time copy; the live keeps changing
underneath it via the theme editor. Compare asset checksums between the draft and the current
live and confirm the only differences are yours. `161529233513` was built that way: duplicated
from the then-live `161069989993`, two snippets added on top, diff verified as exactly 2
additions + 2 modifications and zero unrelated changes.

Publish a draft: `PUT /admin/api/2025-01/themes/{id}.json {theme:{id,role:"main"}}`. Make a fresh draft:
GraphQL `themeDuplicate` of the new live. Verify roles: `GET /admin/api/2025-01/themes.json?fields=id,name,role`.

## API Routes

- `GET /api/catalog` — browse catalog with filters (reads from Turso, not CSV)
- `GET /api/dashboard/llm-usage` — "Consommation API" panel: today's tokens per pool vs its
  cap, estimated USD, and a 7-day window from `daily_llm_budget`. Session-gated, DB-only.
- `POST /api/sync/trigger` — manual sync (supports `{dryRun: true}`)
- `GET /api/sync/history` — sync runs + change logs
- `GET /api/cron/sync` — Vercel Cron: Fluid Compute Phase 1 orchestrator (init+chunks+finalize), fires at 06:00 + 06:30 UTC (Bearer CRON_SECRET, maxDuration 800s)
- `GET /api/cron/sync-refresh` — Manual fallback only: one refresh chunk (not in cron schedule since v0.4.0.0)
- `GET /api/cron/sync-finalize` — Manual fallback only: finalize step (not in cron schedule since v0.4.0.0)
- `GET /api/images/review` — pos-1 swap proposals awaiting approval (`?status=pending|applied|rejected|failed|all`)
- `POST /api/images/review` — `{id, action:"approve"|"reject"}`; approve is the ONLY path that
  writes a pos-1 reorder to Shopify. Page: `/images`.
- `POST /api/import/queue` — queue products by SKU array
- `POST /api/import/generate` — generate Claude content for one job
- `POST /api/import/push` — push reviewed job to Shopify
- `GET /api/cron/morning-report` — Mat's daily 06:00 America/Montreal digest (read-only), sent as the Klaviyo event `Rapport matinal` to `MORNING_REPORT_EMAIL`. Registered at 10:00 AND 11:00 UTC; only the run where Montreal reads 06:xx sends (DST-proof), at most once per day. `?dryRun=1` previews, `?force=1` resends. Setup: `docs/MORNING-REPORT.md`. Its first section is the **guard verdicts** (`lib/guard-status.ts`), and the subject is prefixed `🔴 N garde-fou(s) en alerte` when any is red — the ONE alert email; don't add a second.
- `GET /api/cron/feed-integrity` — 09:45 UTC read-only guard on the ad feeds: every item's `?variant=` link + photo vs a fresh Shopify read, the served Google feed vs that (≤5 % cache drift tolerated), 5 real storefront loads (theme preselects the variant), day-over-day volume. Persists `settings.feed_integrity_audit`.

**Guards → one verdict.** `lib/guard-status.ts` turns the persisted results of price-audit,
catalog-consistency, the image review queue and feed-integrity into red/green/unknown (red also
when a guard's last run failed or it has no result for 36 h). The dashboard "Alertes" panel and
the morning report both read it. **CI** (`.github/workflows/ci.yml`: `npm ci`, tsc, eslint, vitest)
is a required check on `main` (branch protection, admins included) — nothing merges red.

## Prix — jamais à perte, même avec un rabais (2026-10-18)

Mat: « aucun de nos produits ne devrait passer sous notre coût, malgré les rabais ». Two halves:

- **Profit floor** (`sell-price-rule.ts`, `profitFloor` / `withProfitFloor`): with our cost known (Aosom: `2B Product
  Price` + `shiping_fee`), a sell price is never under `(cost × 1.02 + 0.30) / (0.9 × 0.971)` rounded up to .99, i.e.
  still +2 % over cost after the biggest discount (`MAX_DISCOUNT` = 10 %) and card fees (2.9 % + 0.30 $). It beats the
  competitor, the +15 %/+7 % caps, the Aosom floor and the liquidation discount cap (reason `profit`, ranked first in
  the sell-price plan). Auto-import rejects a product whose price needed the floor (not competitive).
- **Margin guard** (`margin-guard.ts`, cron `/api/cron/margin-guard` 11:00 UTC, read-only): flags any ACTIVE discount
  that can take more than `MAX_DISCOUNT` off one item, discounts that combine, discounts that cannot be bounded (fixed
  amount without a minimum, per item, app), and every active variant (Aosom AND Costway) that loses money with the worst
  active discount + fees → notification « Marge à vérifier ».

**Creating a discount:** keep it ≤ 10 % per item and non-combinable (a fixed amount needs a minimum ≥ 10× the amount).
A bigger one needs `MAX_DISCOUNT` raised first (which raises every floor).

## Perf mobile (2026-11-04) — what was removed from the live theme, and why

Audit: 53 % of traffic is Meta in-app mobile, conversion 0.03 %. Applied with `scripts/theme-perf-mobile/apply.mjs`
(exact-string edits on the FRESH live asset, idempotent; backup theme `164084482153` « BACKUP avant perf mobile 2026-11-04 »).
- **Wheel — back ON since 2026-11-27** (Meta ads paused that day, so the in-app traffic that motivated the removal is gone):
  `layout/theme.liquid` on the live theme `164805705833` renders `lc-roue` again. On phone/tablet (≤ 1024 px) it opens by
  itself ONLY on the home page; on phone (≤ 749 px) its tab is hidden on collection pages as on product pages, because the
  mid-height tab covered « Filtrer et trier ». (It was off from 2026-11-04 to 11-27.)
- **Assistant off:** `lc-assistant-widget` is no longer rendered (fab hidden since 10-24, ~1 message/week in `assistant_ip_daily`);
  the « Demandez à Ameublo » button in `lc-pdp-qa` went with it.
- **Visualiser teaser off:** `main-product` no longer renders `lc-visualiser` (« Voyez-le chez vous — BIENTÔT »).
- **Klaviyo is loaded ONCE, by the app embed** (`klaviyo.js?company_id=XAvTkS`). Never re-add a `<script src=…klaviyo.js>` in
  the theme: it ran the SDK twice. The `_klOnsite` stub + « Viewed Product » push in `theme.liquid` stay.
- **Judge.me on a product with 0 reviews** (3,474 of 3,484): `judgeme_core` reads `reviews.rating_count`; at 0 it fetches
  nothing and hides the badge, the widget and the apps section `…__17745733386da0d1df`.
- **Card colour-dot CSS/JS** moved out of `card-product` (it was printed once PER CARD) into `snippets/lc-card-swatch-js.liquid`,
  rendered once from `theme.liquid`.
- First product image: `loading=eager fetchpriority=high` (`product-thumbnail`). The UGC reel starts its videos only near the
  viewport (its observer used `root: track`, so the homepage downloaded a 3 MB mp4 on load).

## Roue de bienvenue (2026-10-19 — off 2026-11-04, back ON 2026-11-27, see « Perf mobile » above)

One spin wheel replaces the homepage newsletter popup (`entry_popup`, BIENVENUE20). Mat's goal: « le plus de
conversions possible ». Plan: 1) build it on a DRAFT theme; 2) publish only on Mat's « publie », then measure for 4
weeks (email-capture rate vs the old popup, code-use rate, AOV with code, margin after discount); 3) if capture is at
least 2× the old popup, add the Club Ameublo v3 page (retention, linked from Klaviyo) and use the truck game on social.

- **Server:** `POST /api/roue` (`src/app/api/roue/route.ts`, lib `src/lib/welcome-wheel.ts`, table `wheel_spins`).
  The server draws the prize (crypto), one spin per normalized email (gmail dots/+tags collapse), ≤ 4 spins/IP/24 h,
  honeypot, Origin allowlist. Kill switch: `settings.roue_enabled = "0"` → 503 and the snippet hides itself.
- **Prizes = slice sizes = real odds:** 15 $ dès 150 $ 45 %, 25/250 30 %, 40/400 17 %, 60/600 7 %, 100/1000 1 %.
  Each is exactly 10 % of its minimum, so it passes the margin guard. Keep `WHEEL_PRIZES` and the snippet's `P` array
  in the same order, because the server returns the index.
- **Code:** unique `ROUE-XXXXXX`, a DiscountCodeBasic with usageLimit 1, valid 72 h, combining with shipping only.
  The snippet auto-applies it through `/discount/CODE`.
- **Klaviyo** (with `email_provider` = resend: none of this — the spin, the ticked box and `email_via='resend'` stay in
  Turso and our engine sends the 3 code emails, see « Courriel gratuit »):
  - the consent box is OPTIONAL (CASL: consent cannot be a condition of playing). Ticked → the visitor is subscribed
    to the list « Roue de bienvenue (site) », NOT the newsletter list, so the Welcome Series and its BIENVENUE20 don't
    fire as well. Unticked → nothing goes to Klaviyo (no subscribe, no event, no `klaviyo.identify`); the visitor
    keeps the code on screen (« Note ton code ») and in the cart;
  - the list id is in `settings.roue_klaviyo_list_id`;
  - the event « Roue gagnée » triggers the flow « Roue de bienvenue — code 72 h (FR/EN) », with 3 emails at
    +10 min (lets the async consent land), +24 h and +60 h, skipped once the person orders;
  - setup script: `.context/roue/setup-klaviyo-roue.mjs` (main clone, untracked; `--apply`, then `--live <flowId>` at publish).
- **Theme:** `snippets/lc-roue.liquid` (source of truth `.context/roue/work/`), rendered from `layout/theme.liquid`.
  - v2 (Mat: « on se perd, pas assez d'emphase sur la roue »): gold kicker « Roue de fortune · chaque tour gagne »,
    gold rim with twinkling bulbs, slow idle turn while open, « TOURNE » hub, tab with a mini wheel icon. One task per
    step: 1) email + button (+ optional box), 2) skill question, 3) prize + code + countdown.
  - Pin and overlay are `<span>`s: the theme hides every empty `div` (`div:empty{display:none}`).
  - EN copy says « Furnish Direct » (the EN brand), FR « Ameublo Direct ».
  - The snippet GETs `/api/roue` first; with the kill switch on, nothing appears (re-checked after 24 h).
  - Desktop: it opens by itself once, after 20 s, 50 % scroll or exit intent. Phone: 25 s or 60 % scroll.
  - It opens by itself only for NEW visitors. It stays quiet (tab only, marked seen) for:
    - a logged-in customer (Liquid `customer`, via `data-customer`);
    - an email click (`_kx`, `utm_medium=email`, `utm_source=klaviyo`);
    - a visitor Klaviyo already identifies: the `__kla_id` cookie is base64 JSON and holds `$exchange_id` / `$email` once known.
    - `klaviyo.isIdentified` is NOT callable on this store (checked 2026-10-19), so don't rely on it.
  - Phone: it opens by itself only on the home and collection pages, never over a product page. Elsewhere it is a
    left-edge tab, because the bottom corners belong to the assistant and Messenger.
  - After a win, the tab shows the prize and a 72 h countdown.
- **Repeat spins never return the code** (anyone can type someone else's email): the dialog says « Un tour par personne ».
- **Margin guard paginates** active discounts: every spin adds one single-use code for 72 h.
- **Legal:** no purchase is needed, the odds and rules are in the dialog, and consent is never pre-checked (CASL).
  - Short rules under the form (Competition Act s.74.06): no purchase · Canada 18+ · skill question · closing date
    31 janvier 2027 (`ROUE_ENDS_AT`; the server closes after it — move it together with the snippet text to extend).
  - Privacy-policy link at the point of collection (Québec Loi 25).
  - RACJ: Québec stopped regulating publicity contests on 2023-10-27 (Bill 17), so there is nothing to declare.
  - **Skill-testing question** (Criminal Code s.206, approved by Mat 2026-10-19): the form asks « a + b × c = ? »
    (random small operands). The snippet checks it and draws a new one on a wrong answer; the server re-checks it
    with `isSkillAnswerCorrect` and answers 400 `skill` otherwise.
  - CASL mailing address: Mat will get a PO box (case postale); add it to the form and the 3 emails once he sends it.

## Offre de remerciement (thank-you page) — V1 built 2026-11-21, OFF until Mat says so

Right after payment, the Thank you page shows ONE product that goes with the purchase (+ one alternative of another
type) with a small discount valid **30 minutes**. The button opens a **new, separate order** at checkout with the code
already applied and Shop Pay selected (`/cart/{variant}:1?discount=CODE&payment=shop_pay`), so nothing changes in the
way supplier orders are placed. The real one-click post-purchase page is NOT possible for us: on Shopify Basic only
App Store apps may use it (custom apps need Plus) — see the 2026-11-21 analysis.

- **Rules** (`src/lib/post-purchase/offer-rules.ts`, pure): anchor = most expensive line; hand-written category map
  (armchair → side table/arm tray/lamp/rug, buffet → trash can/kitchen cart, tree → wreath/lit decor…); never the
  same product type as anything in the order (head-noun guard: no 2nd table/tree/sofa — title targets « ~… » only
  widen matching, they never lift these guards); never appliances nor anything that heats (« chauffage/chauffant/
  radiateur/heater » anywhere, except « bois de chauffage »); no fireplace unit of any kind: in the fireplace area only
  accessories pass (racks, tools, logs, screens, grates) — anything powered ([ée]lectri, Wi-Fi, DEL/LED, quartz, watts)
  or whose title starts with foyer/poêle/cheminée/insert is out, and fireplace furniture elsewhere (« Meuble TV
  cheminée / foyer électrique ») is out. « Électrique » alone elsewhere (kids' cars, filing cabinets) is fine.; seasons (Halloween Sep–Oct, Christmas Nov 1 – Dec 15, summer patio blocked Oct–Mar
  except covers/deck boxes/shovels); price
  ≤ max(50 % of the anchor, 50 $) and ≤ the anchor, ≥ 15 $; ranking = map order, colour family, price near 30 %.
  No good candidate → nothing is shown (never a weak pick).
- **Discount = what the margin allows, per variant, at today's cost:** 10 % if we keep ≥ max(8 $, 8 %) after it and
  the card fees, else 5 % with the same test, else the variant is not offered. Deep "−40 %" Aosom items are mostly
  excluded by this (they sit at ~1.17 × cost). Codes never exceed MAX_DISCOUNT, so the margin guard stays green.
- **Catalogue:** `GET /api/cron/merci-catalog` (10:45 and 18:15 UTC, after the feed refreshes; `?dry=1`
  writes nothing) rebuilds table `merci_candidates` (generation in `settings.merci_catalog_gen`): ACTIVE + published
  + photo + in stock (Aosom: today's feed qty and cost, `image_checked_at`, no open image review; Costway:
  `ca_qty`, `costOf(price)`). Each variant carries its own photo and its option values in the title. Same run
  deletes MERCI codes that ended > 2 days ago. `?dry=1` does not even write the cron_runs row.
- **Live re-check at offer time** (`live-check.ts`): 8 products (best 4 of the top type + best 4 of other types) and
  up to 2 sibling variants each (fallback when the chosen variant fails) are re-read before any code: Shopify live
  price/compare-at, ACTIVE + published; stock from Turso rows by SKU (Aosom `products.qty`, kept fresh by the sync,
  with the catalogue's cost of the day; Costway row with its cost). **The request path never downloads the Aosom
  feed.** Tier recomputed with the same floor, cap re-applied. Every external call has a 6 s timeout and the whole
  answer a 20 s deadline: slow or failing = no offer (fail closed). The price shown = the checkout price.
- **API:** `POST /api/merci/offer` (public path; CORS `*` because extensions run in a Web Worker; the gate is the
  session token — HS256 JWT signed with the app secret, `aud` = client id, `dest` = our store; `maxDuration` 30 s).
  Body `{orderId, confirmationNumber}` from `shopify.orderConfirmation`. The order is re-read via the Admin API on
  every call, reloads included (202 while Shopify has not created it yet — the block retries 6 × 3 s) and must
  belong to the caller: the confirmation number must match, and a token `sub` must be the order's customer
  (else 403). Orders > 2 h old, cancelled, or paid with a MERCI- code get nothing. Table `post_purchase_offers`: one
  row per order, reserved under a random `claim` before any code exists; only the claim owner may finish/release
  it, so a superseded request can never overwrite the expiry — **expiry fixed once → the timer never resets**. One
  unique `MERCI-XXXXXXX` code per offered variant: a fixed amount (price × pct, rounded down to the cent) taken ONCE
  per order on that variant only, minimum subtotal = amount / 10 % (the lowest the margin guard still bounds at
  ≤ 10 %: a 5 % code survives a ~50 % price drop; a 10 % code has only cents of slack), usageLimit 1,
  once per customer, combines with shipping only, ends with the offer. Link quantity is 1.
- **Logs (QA):** `[merci] 403 #1150: confirmation-mismatch (…)` (which ownership check failed, no PII), `[merci] 202`,
  `[merci] 401 token: <reason>`, `[merci] 500 …: <cause>` (timeouts included), `[merci] #1150: no offer (ranked n, verified n)`.
- **Settings:** `merci_offer_enabled` = "1" → everyone (default OFF). `merci_offer_test_emails` (comma list) → those
  order emails get it while OFF (QA on real orders).
- **Env (Vercel):** `SHOPIFY_MERCI_APP_SECRET` (app Client secret), `SHOPIFY_MERCI_APP_CLIENT_ID`. Missing → 503 and
  the block renders nothing.
- **Block:** `shopify-app/` (app "Ameublo Merci", extension `merci-offre`, target `purchase.thank-you.block.render`,
  `network_access = true`). French copy, calm tone (no "Dernière chance"), countdown from the server's `expiresAt`,
  fine print « … Rabais de X % sur 1 article par commande, valide 30 minutes. 1 utilisation, non cumulable avec
  d'autres rabais (livraison toujours incluse). » Waits for `orderConfirmation` (signal) if it arrives late. Calls
  `https://outils.ameublodirect.ca` (our alias of this app — never the vercel.app name, which carries the supplier
  name). Renders nothing on error/empty/expired/403. Excluded from Next/tsc/eslint; built only by the Shopify CLI.
- **Deploy steps (Mat — need his Shopify login):**
  1. Dev Dashboard (dev.shopify.com) → Create app « Ameublo Merci » → distribution **Custom** → store 27u5y2-kp.
  2. Settings → Access requests → **Enable network access**.
  3. Put the Client ID in `shopify-app/shopify.app.toml` (`client_id`), and on Vercel set
     `SHOPIFY_MERCI_APP_CLIENT_ID` + `SHOPIFY_MERCI_APP_SECRET`, then redeploy.
  4. `cd shopify-app && npm install && shopify app deploy` (login prompt), then install the app on the store
     with the custom-distribution link.
  5. Run `GET /api/cron/merci-catalog` once (Bearer CRON_SECRET) to fill the catalogue.
  6. Shopify admin → Settings → Checkout → **Customize** → page **Thank you** → Add app block « Offre de
     remerciement » → Save.
  7. QA: set `merci_offer_test_emails` to a test email, place a real order, check timer/code/checkout, then
     cancel/refund it. Go live with `merci_offer_enabled` = "1" only on Mat's OK.

## Parrainage (built 2026-11-27, OFF until Mat says so)

Variante A approved by Mat: unique Shopify discount codes, never store credit (store credit stacks with everything and
the margin guard cannot bound it). Code: `src/lib/referral/` (`rules.ts` pure: codes, discount inputs, anti-fraud;
`credits.ts` the cron engine with injected deps; `store.ts` Turso; `shopify.ts`; `launch.ts`).

- **Codes** (all: fixed amount once per order, minimum 10 × the amount → the margin guard reads exactly 10 % =
  `MAX_DISCOUNT`; combine with shipping discounts only; title starts with the code):
  - per customer `MERCI10-XXXXXX` 10 $ dès 100 $ (sous-total avant taxes), 1 use, 60 days;
  - per customer `AMI-XXXXXX` 10 $ dès 100 $, up to 10 uses, once per customer, 90 days, meant for a friend's first
    order (Shopify cannot restrict that; the cron only credits a first order);
  - referrer credit: a new `MERCI10-` 10 $ dès 100 $, 60 days, max 5 per referrer (a revoked credit frees its slot).
- **Cron `GET /api/cron/referral-credits`** (hourly, :25; Bearer CRON_SECRET; in-process, never a self-fetch): orders of
  the last 72 h with an `AMI-` code, each decided ONCE in `referral_uses` (row reserved 'pending' under a claim before any
  code exists → `credited` / `rejected` + reason; later `revoked`). Anti-fraud (`evaluateReferral`, tested): paid and not
  cancelled/refunded/test, friend's first order (prior orders by customer or email), normalised email (gmail dots/+tags),
  phone and shipping address ≠ the referrer's (stored hashes + the referrer's live Shopify addresses). Not paid yet →
  nothing written, looked at again next hour. A failed read decides nothing. Then up to 25 credits are re-checked: friend
  refunded/cancelled and credit unused → `discountCodeDeactivate` + `revoked`. A 'pending' row older than 1 h means a run
  crashed between reserving and recording — reported (`BLOQUÉS=`), never auto-retried (no double credit).
- **Email 2** (« Votre ami a commandé ») goes through `dispatchEvent("Parrainage — crédit", …)` (src/lib/email/dispatch.ts):
  with `email_provider` = klaviyo it is the Klaviyo event **`Parrainage — crédit`** on the referrer (code, montant, minimum,
  expire_le, langue — nothing about the friend, Loi 25) → a flow Mat builds from `docs/klaviyo/parrainage-credit.html`
  (⚠️ native Klaviyo flows have never sent on this account except X49Zbn); with `email_provider` = resend the email itself
  goes out through Resend (`direct.ts`, idem key `parrainage-credit:<code>`, priority 0, queued if the cap is reached).
- **Switch `settings.referral_mode`** = off | dry | live, **default off**; `?mode=` overrides one call. dry = same plan,
  reported, zero writes (no Turso row, no Shopify code, no Klaviyo event).
- **Tables:** `referrals` (customer, email, langue, codes, credits, phone/address as salted hashes, `klaviyo_synced`),
  `referral_uses` (order, verdict, reason, credit code).
- **Launch:** `scripts/referral-launch.mts` — dry run by default (eligible = buyers of the last 2 years [CASL business
  relationship] + email subscribers, minus Shopify unsubscribed/redacted/invalid and Klaviyo unsubscribed/suppressed; a
  Klaviyo lookup error excludes). `--apply --list-fr <id> --list-en <id>` creates both codes per customer, writes
  `referrals`, sets the Klaviyo profile property `parrainage` {code, code_ami, langue, code_expire, code_ami_expire}
  and adds the profile to the FR/EN list (no consent change). Re-runnable. Email 1 = a campaign Mat sends to those
  lists from `docs/klaviyo/parrainage-merci.html`. **`--via resend --per-day N`** (default 50, max 90) instead: no Klaviyo
  at all, courriel 1 (unique codes per customer — Shopify Email cannot do that) is queued in `email_outbox`, one slice per
  day at 14:00 UTC, idem key `parrainage-merci:<referral id>`, `referrals.klaviyo_synced = 2`. Refused unless
  `email_provider` = resend (the queue only drains then).
- ⚠️ **Needs Mat's explicit OK:** running the launch with `--apply`; creating the Klaviyo lists, the flow and sending the
  campaign; setting `referral_mode` to `dry` then `live`. Never name the friend in any email; never name a supplier.

## Pastilles de couleur = photo de la couleur (2026-10-18)

Mat: « la pastille de couleur n'avait aucun rapport avec l'image ». Audit of the 1,023 multi-colour products (3 vision
passes, 9 agents) found these causes; each now has a guard:

| Cause | Guard |
|---|---|
| Import attached colour photos by POSITION (a refused upload shifted every later colour) | `attachVariantImages` matches by FILE (`variant-photos.ts#imageKey`); Costway maps neutral names back via `neutralSourceOf` |
| A colour took a photo Aosom lists under several colours (lifestyle shot) | only EXCLUSIVE feed photos count (`exclusiveImages`), also in `ensureVariantPrimaryImages` |
| Products drafted on 2026-09-30 missed the one-off backfill; deleted/replaced images leave variants without photo | daily cron `/api/cron/variant-photo-guard` (11:30 UTC, `settings.variant_photo_guard_mode` off/dry/live, default live, cap 150/run) re-attaches/uploads each colour's own photo |
| Aosom renamed a SKU suffix → colour has no feed photo | guard looks up the PSIN twin with the same colour |
| Card and product page used two different colour maps; substring matching ("floral" → or) | ONE theme snippet `lc-colour-css` (whole words, split dot for "Noir et blanc"), used by `card-product` and `main-product` |
| Card hover on a colour without photo kept the previous colour's photo | hover restores the card photo |
| Renaming an option value keeps its old EN translation | `registerOptionEnTranslations` replaces a stale translation |
| Costway feed files a different product under one item (snow thrower + ride-on car) | `sameProductRows`: a variant of another category is dropped at import |
| Daily sync REPLACED whole galleries (~20/day): it compared Shopify CDN URLs to feed URLs, which never match, and a new gallery drops every variant's image link (found 2026-10-19) | the gallery is import-time content like body_html: `diff-engine` only repairs an EMPTY gallery; any gallery push re-attaches colours via `attachVariantImages` |

The guard also notifies « Couleurs à vérifier »: labels contradicting the supplier colour (never auto-renamed — the
photo decides, a human confirms) and colours with no own photo in the feed. Limit: a variant photo whose file Aosom has
since renamed cannot be judged by file; only a vision audit (`.context/swatch/` scripts in the main clone) catches those.

**Rule — « blanc » in the colour ⇒ white swatch** (Mat, 2026-10-20). If a colour name contains the WORD
`blanc` / `white` (« Blanc crème », « Blanc cassé », « Cream white », « Blanc ivoire »…), its swatch is pure white
`#FFFFFF`, and the other words (crème, ivoire, cassé) do not change that. Two-colour names (« Noir et blanc »,
« Gris et blanc ») keep the split dot. Why: the old map drew `crème`/`cream` as `#FFFDD0`, which is pale yellow.
A customer saw a pale yellow dot next to a photo with a white seat (83A-654V00CW « Blanc crème ») and asked if it was
the same product. Any swatch map (`lc-colour-css`, the theme, a script) must check for `blanc`/`white` BEFORE
`crème`/`ivoire`/`cream`.

How `lc-colour-css` applies it (copy in `shopify-theme/snippets/`): per part, the word `blanc`/`white` wins unless
the same part also names another colour (`noir`, `gris`, `bleu`, `black`… — so « black white » keeps its divided dot);
materials (« wood grain », « vieilli ») don't count. `/` also splits a value (« Orange/Green »). On 2026-10-20 this
changed 4 values: Blanc crème (57 products), Blanc vieilli (7), Cream White (3), Cream White Wood Grain (1). Shopify's
native option-value swatches are NOT used (0 set). `scripts/apply-swatches*.mjs` are obsolete and throw.

## Avant/Après — removed (2026-10-01)

The before/after video format and its `/studio` page were removed entirely at Mat's request (poor results, never used): renderer, Studio APIs, `before_after_schedule`, its queue rows and Blob files. Don't rebuild it. `publication_queue`'s CHECK still lists `before_after` only so the historical migration stays a no-op; nothing writes it.

## Costway — second supplier (catalogue only)

Costway lives in its **own table `costway_products`**, fully separate from the Aosom `products`
table. It is fed daily by `/api/cron/costway-sync` (16:00 UTC) from `COSTWAY_FEED_URL` and browsed
at `/costway`. Code: `src/lib/costway/` (`feed.ts` parser, `sync.ts` diff + writes, `db.ts` queries).

- **The feed is not RFC CSV.** Values are never quoted and commas are stripped from them, so it is
  parsed by splitting each line on `,`. Never parse it with `csv-parse`: its quote handling merges
  rows at inch marks (`73"`).
- **Nothing from Costway is on Shopify yet.** The Aosom jobs are already scoped away from Costway
  products (isolation phase 1): the three whole-catalogue Shopify sweeps — `fetchAllShopifyProducts`
  (feeds the `computeDiffs` archive diff, removed-catalog, stale-catalog, price-audit),
  `fetchActiveVariantInventory` (inventory-sweep) and `fetchShopifyVariantsPage` (price-reconcile) —
  skip every Shopify product id listed in `costway_products.shopify_product_id`
  (`getCostwayShopifyProductIds`, **fail-closed**: a DB error aborts the sweep). The id set is read by
  Shopify product id, NOT by tag, because tags are public and would expose the supplier name.
  **The Costway import MUST write `costway_products.shopify_product_id` in the same step that creates
  the Shopify product**, before any Aosom sweep can run — otherwise inventory-sweep would enable
  tracking on the new variants and zero them (absent from the Aosom feed). Stock-check, the
  `assertFeedComplete` baseline and publish-reconcile read the Aosom `products` table, so they were
  already scoped. `fetchDraftProductStates` / `fetchProductPublishStates` are tag- or baseline-scoped
  and left alone; a future Costway stock job must not reuse the `auto-drafted` tag unscoped.
- **Costway identity — same rules as Aosom: our OWN titles/handles/SKUs, the supplier never shows**
  (`src/lib/costway/identity.ts`). The feed has 22,670 variants / 12,214 products; 709 bodies mention
  "Costway", 4 titles/handles do, and all 22,660 image URLs are on `assets.costway.ca`.
  - **SKU:** the supplier SKU (`02956471_CB10061BK`) and numeric item number are NEVER sold under or
    shown. Each imported variant gets an opaque internal SKU (`M` + 7 Crockford-base32, e.g. `M7ZGG3GC`,
    `costway_products.internal_sku`, UNIQUE index) from `assignInternalSkus()` — lazily, only for variants
    being imported, deterministic, collision-checked against BOTH `costway_products` and the Aosom
    `products.sku` space. Everything keyed on SKU (stock, price, feeds, pixel `content_ids`) must use it.
  - **Title / handle / body:** generated by `generateProductContent` from the content, never the feed's
    title, handle or `product_url`. `Costway` is now on the shared `SUPPLIER_BRANDS` list, so it is stripped
    from titles, descriptions, handles and (new) **tags**, and forbidden in the prompts.
  - **Images:** Shopify keeps the SOURCE filename in its CDN URL, and Costway's are the supplier's model
    numbers (`cb10061bk.jpg`) — upload under `neutralImageFilename()` (`m7h3k9q2-1.jpg`), don't ingest by URL.
  - **Gate:** `findCostwayLeaks(text, costwaySkus)` (brand, domain, supplier SKU, item number) must return
    `[]` for every text field before a Costway product is created.
- **Costway pilot import (2026-10-03, batch `pilot-1`: 50 appliances — dehumidifiers, washers, dryers).**
  Fulfilment is MANUAL: Mat orders each item on costway.ca by hand and sends tracking by hand, so there is
  no order/tracking sync. Everything is created as **DRAFT** — nothing is live until Mat publishes it.
  - **Run it:** `scripts/costway-import.mts prepare` (picks by margin, writes the copy, runs the image /
    language / supplier-leak gates → a reviewable plan file) → `apply --apply` (drafts, linked in
    `costway_products` immediately, neutral-named images, tracked stock) → `repair --apply` (re-uploads any
    image whose download failed; `assets.costway.ca` drops ~40% of burst downloads, the script retries).
    Resumable and idempotent. Under node-x64 with `--env-file=<main clone>/.env.local`.
  - **Tracking in aosom-sync:** `costway_products.shopify_product_id / internal_sku / import_batch /
    import_status / sell_price / imported_at` + the `/costway` page (status column, filters, summary) +
    a Shopify tag `src-c` (neutral, public) and the internal unpublished collection `suivi-source-c`.
  - **Manual ordering:** the Shopify SKU is opaque (`M…`); paste it in the "Recherche de commande" box on
    `/costway` (or `GET /api/costway/lookup?q=`) to get the supplier SKU, link, colour, cost and stock.
  - **Categories:** product_types `Home Furnishings > Appliances > {Dehumidifiers, Washing Machines, Clothes
    Dryers, Washer Dryer Combos}` land in Électro & Tech and Climatisation & Ventilation through the existing
    smart collections; new collections `electro-deshumidificateurs` and `electro-buanderie` were created by
    `scripts/costway-setup-shopify.mts`. **Not yet in the storefront menu** — run it with `--apply --menu` at
    go-live, or the daily category guard will flag the published products as unreachable.
  - **Discounts — Costway INCLUDED since 2026-10-18 (Mat: "les produits Costway peuvent faire partie du rabais
    ou de n'importe quel rabais"):** `rabais-2e-article` (every product with a price > 0) is the audience of the
    automatic "10% sur le 2e article". From 2026-10-03 to 2026-10-18 it carried `TAG NOT_EQUALS src-c`; that rule
    was removed and `costway-setup-shopify.mts` step a) now removes it if it ever comes back. Every other discount
    (BIENVENUE20, automatic ones) targets all items. The listed price rule is unchanged (never below Costway's
    price / Price Drop); only checkout discounts may now go under it.
  - **Go-live (done 2026-10-03: all 50 of `pilot-1` are live):** the Aosom-job isolation must be MERGED AND
    DEPLOYED first — drafts are safe because the archive / stale / removed jobs only touch `status:"active"`,
    but a published Costway product would be drafted or zeroed by the next sync without it.
    `scripts/costway-publish.mts` (dry run by default, `--apply`, `--only <item>`) re-reads each product and
    refuses to publish one that is not a clean draft with the `src-c` tag, internal SKUs, neutral images, sellable
    stock and an entry in the isolation set; it then sets `import_status='active'`. Publish ONE first, check the
    public page and a 2-unit cart (`/cart/add.js` then `/cart.js`: since 2026-10-18 the BXGY applies, ~10% on the
    second unit, same as an Aosom product), then the rest, then
    `costway-setup-shopify.mts --apply --menu`. Rollback: `unpublishShopifyProduct(id, { deactivate: true })`.
  - **Gotchas learned:** Costway's category is unreliable (towel warmers filed as dryers) so products are
    classified from the title; "Washer and Dryer" in a Costway title does not always mean a combo unit;
    colours are translated to French (`Gray` → `Gris`); each colour's own first photo must be in the gallery
    (the 8-photo cap used to leave the second colour with none — `galleryFor`).
- **Costway stock → Shopify, per variant** (`src/lib/costway/stock-sync.ts`, cron `/api/cron/costway-stock` 16:30 + 22:30 UTC, after costway-sync). Added 2026-11-23 after order #1155 sold a colour Costway had out of stock: a variant's Shopify quantity was set ONCE at import and nothing moved it again (`costway-sync` is catalogue-only, `inventory-sweep` skips Costway, `sold-out-hide` drafts only when EVERY variant is unsellable). Target = 0 if removed / `in_stock = 0` / under 3 units, else `sellableQty` (cap 50). Down is always written; up only for a variant THIS job closed (`settings.costway_stock_closed` = targets at 0 at the previous run), so a variant customers sold to 0 is never re-opened while Costway still shows units; an untracked variant gets tracking on, then its target. Each write is re-checked against a fresh Shopify read just before (a sale in between is never overwritten upward). Covers every non-archived imported variant (not only `import_status = 'active'`). Guards: costway-sync older than 30 h → no run; mass-zero breaker (> max(150, 40 %) of sellable variants; `?force=1` overrides once); 250 writes/run; canary re-read; one alert per kind per day. **`settings.costway_stock_mode` = off | dry | live, default dry**; `?mode=` overrides one call. ⚠️ `in_stock` and `qty` can disagree in the feed (flag 0 with qty 46): the flag wins.
- **Costway pricing rules:** `Variant Price` is Costway's real selling price (verified on 36 live pages: equal
  on 83%, never lower than the site, the site up to 3% lower only on "Drop Price" items). Our cost is that
  price less the 16% dropship discount. We sell at the feed price, ×0.97 on "Drop Price" items, never below
  `Price Drop`, and never reuse Costway's crossed-out price (`src/lib/costway/pricing.ts`). Stock: sold out
  below 3 units at Costway, Shopify quantity capped at 50. No promotion may take a variant under `Price Drop`.

## Publication scheduling — `publication_queue` (unified)

All publishing now flows through the **publication queue**. The legacy
`facebook_drafts.status='scheduled'` path is retired: its cron
(`/api/cron/social-scheduled`) was removed from `vercel.json` (v0.5.53.93), so a
`scheduled` row would never publish.

- **Approve:** `POST /api/social {action:"approve"}` enqueues the draft into
  `publication_queue` (one item per active brand) on the next free slot from the
  configurable `publication_schedule` (settings, edited via `/api/settings/schedule`,
  computed by `getNextAvailableSlot` in `publication-scheduler.ts`). The draft stays
  `approved` in `facebook_drafts`. The `/drafts`-page approve server action
  (`drafts/actions.ts`) auto-enqueues `content_template` drafts the same way.
- **Manual schedule (operator picks a time):** both `POST /api/social {action:"schedule"}`
  and `POST /api/social/drafts/:id/schedule` enqueue into `publication_queue` at the chosen
  time (cancel-then-enqueue via `cancelPendingQueueItems`, so re-scheduling moves the post
  instead of duplicating it). The draft stays `approved` — neither writes
  `status='scheduled'` anymore. `DELETE /api/social/drafts/:id/schedule` cancels the draft's
  pending queue rows and reverts it to `draft`.
- **Publish:** **`GET /api/cron/publisher`** (hourly) drains the queue and publishes.

Slot collisions are rejected by `publication_queue`'s partial-unique index as
`QueueSlotTakenError`: approve retries the next free slot; the explicit-time schedule
paths skip the colliding brand (they can't shift the operator's chosen time).

**Cleanup (done):** `/api/cron/social-scheduled` and `processScheduledDrafts()` have been
removed — nothing writes or drains `facebook_drafts.status='scheduled'` anymore.
`draft-scheduler.ts` is **kept**, but only half of it is live: `isSqliteUtc` still validates
queue slots in `addToQueue`. `nextFreeSlot` lost its only caller when `/api/queue/add` was
deleted in v0.5.76.0 (dead route, no caller anywhere) — it is retained and tested but unused,
because a future queue feature is its obvious consumer. Do not read it as live wiring. The
`scheduled` status value survives only for any historical rows; no code produces new ones.

## Blog pipeline — and why crons must NEVER self-fetch

⚠️ **A cron must do its work in-process. Never `fetch()` your own app from inside a cron.**

Vercel **SSO Deployment Protection** is enabled on this project
(`ssoProtection.enabled: true`, `deploymentType: "all_except_custom_domains"`), and the project
has **no custom domain**. Protection is **not uniform across hosts** — measured 2026-08-09 on
`/api/cron/blog` with no credentials:

| Host | Result | Answered by |
|---|---|---|
| `aosom-sync.vercel.app` (production alias) | `401` + `{"success":false,"error":"Unauthorized"}` | the **app** (`verifyCronSecret`) |
| `aosom-sync-<hash>-<team>.vercel.app` (per-deployment) | `302 Redirecting...` | the **Vercel SSO edge** |
| `aosom-sync-git-main-<team>.vercel.app` (branch alias) | `302 Redirecting...` | the **Vercel SSO edge** |

So a self-`fetch()` is intercepted **before the app's own `CRON_SECRET` check** whenever the
origin resolves to a per-deployment or branch host (`fetch` follows the 302 into the SSO flow
and ends at a 401). The cron derived its origin from `new URL(request.url).origin`; **which
host a Vercel Cron invocation actually presents was not verified** — do not assume it is the
production alias, which is what the old code comment in `cron/content/route.ts` claims.

Either way the hop is the hazard, and removing it removes every variant of the failure. Do not
re-derive this from the API value alone: `all_except_custom_domains` did **not** mean "every
`*.vercel.app` host is protected" here. **Measure each host** before concluding.

This silently killed `/api/cron/blog` for ~7 weeks (4 runs / 4 failures, last real article
2026-06-22) and still kills **`/api/cron/content`** (13 / 13, `FR: Generation failed (HTTP 401)
| EN: ... (HTTP 401)`) — that one is **not yet fixed**. Every cron that works in-process has
zero errors. Verify with
`get_project_deployment_protection`, not by guessing.

- **Generation lives in `src/lib/blog-generator.ts`** (`generateBlogArticle`) and the cron calls
  it directly. `/api/blog/generate` is a thin wrapper kept for manual/admin use.
- **`GET /api/cron/blog`, Mon + Thu 08:00 UTC.** GET, not POST — **Vercel Cron only issues GET**,
  so a POST handler would never fire.
- **Topic selection advances per RUN, not per week** (`blog-topics.ts`). Mon and Thu share an ISO
  week, so `idx = week % len` would hand both runs the same topic and publish duplicates.
  `idx = (week * RUNS_PER_WEEK + slot) % len` is a sequential run counter (step of exactly 1),
  which also keeps full catalogue coverage — a step of 2 over an even catalogue reaches half.
- **`blog_schedule.posts_per_week` counts ARTICLES, not bilingual pairs.** 2 runs × (FR + EN) = 4.
  A lower cap silently blocks the late run while still paying to generate it.
- **`blog_posts`** logs every outcome including failures → surfaced at `/blog`.
- Auto-publish gate (`blog-auto-publish.ts`): Claude judge ≥ 80 **AND** in season **AND** under
  the weekly cap. Any miss leaves the article a draft.
- Blog IDs: FR `90302349417` (*Actualités*), EN `91161428073` (*Blog*).

## Courriel gratuit — un seul aiguillage `settings.email_provider` (built 2026-11-27, default `klaviyo` = unchanged)

Mat chose the FREE route over a paid Klaviyo plan (free Klaviyo = 250 active profiles, then it blocks every send;
500 emails/month). Guide for Mat: `docs/EMAIL-GRATUIT.md`. Engine details: `docs/EMAIL-ENGINE.md`.

- **`email_provider`** = `klaviyo` (default, today's behaviour, the legacy `email_engine_mode`/takeover still apply) |
  `test` (Klaviyo keeps mailing customers; Resend mails ONLY `email_test_recipients`, every flow) | `resend` (every
  automatic email through Resend, the Klaviyo relays stand down). Set from the dashboard email panel (`POST
  /api/email/status {action:"provider"}`, refused while configuration is missing); entering `resend` stamps
  `email_provider_since`. **A non-klaviyo provider with any configuration problem behaves as `klaviyo`** (`routeFor`).
- **What moves with `resend`:** flow emails (roue 1-3, bienvenue 1-2, baisse de prix, checkout reminders 1-2) = engine
  `/api/cron/email-flows`; checkout reminder #2 with the 15 $ code = still decided by `relance-paiement` (Shopify code)
  but sent by Resend; cart reminder = `cart-relay` sends by Resend; morning report, publication alert, price-alert and
  back-in-stock confirmations/alerts, referral credit = `dispatchEvent()` (`src/lib/email/dispatch.ts`, templates in
  `direct.ts`) instead of `trackEvent`. flow-relay owns nothing any more (`allRelayKeys`).
- **Resend free = 100/day, 3,000/month.** `sendEmail` checks the cap before claiming an email (`email_daily_cap` default
  95, `email_monthly_cap` 2900). Priority tiers (`TIER_SHARE`): 0 transactional + wheel codes + referral credit (100 %),
  1 cart/checkout (90 %), 2 reviews (75 %), 3 other marketing incl. referral launch (60 %). Over the cap: flow emails are
  retried next run inside their grace window; direct emails wait in **`email_outbox`** (drained by email-flows, highest
  priority first, expiry per email). Same idem key in `email_sends`, the outbox and Resend's Idempotency-Key: never twice.
- **Profiles out of Klaviyo (`resend`):** `/api/roue` writes the ticked box to **`email_consents`** (always, whatever the
  provider) and `wheel_spins.consent/email_via='resend'`, and sends NOTHING to Klaviyo; the engine reads those spins
  from Turso (`wheel-source.ts`, pid `email:<address>`, orders matched by email). Price-alert / waitlist skip
  `identifyProfile`. ⚠️ Shopify-originated triggers (Checkout Started, Added to Cart, Placed Order, newsletter
  subscriptions) STILL come from Klaviyo's Shopify integration — that is what still creates ~35 profiles/week; only the
  sending left Klaviyo. Disconnecting that sync needs Shopify webhooks as trigger source first (not built).
- **Unsubscribes:** one-click link in every email (CASL/RFC 8058) → `email_suppressions` + `email_consents` → pushed to
  Klaviyo AND, once the provider left `klaviyo`, to the Shopify customer (`email_suppressions.in_shopify`, so Shopify
  Email campaigns skip them). Pushing the wheel's SUBSCRIBED consent to Shopify (creates customers) only with
  `settings.email_consent_to_shopify` = "1" — off by default because Klaviyo's Shopify sync would copy every new customer
  back into Klaviyo.
- **General campaigns** (Boxing Day, seasons) = **Shopify Email** (10,000/month free with Shopify Basic, Shopify consent),
  never Resend (100/day). Shopify Email cannot carry a unique code per customer — that is why referral courriel 1 uses
  Resend (`referral-launch.mts --via resend --per-day N`).
- **Klaviyo headroom until the switch:** `scripts/klaviyo-headroom.mts` (dry run by default) lists active profiles that are
  neither buyers nor subscribers (Klaviyo or Shopify), older than 14 days, with no cart/checkout/wheel event in 7 days;
  `--apply` SUPPRESSES them (reversible, `--undo <backup>`; never deletes). Dry run 2026-11-27: 252 active / 250, 21 to
  suppress → 231. Also counts the Shopify subscribers whose Klaviyo profile is suppressed (41, 40 of them on 2026-11-13).
- ⚠️ **Needs Mat's explicit OK:** setting `email_provider`, any `--apply`, any Resend/DNS/Vercel change.


## Panier abandonné — un seul canal, pas deux

La récupération de panier abandonné passe **uniquement par le popup du thème** (2 écrans
+ rabais automatique 10%, "LIVE 2026-09-16 — Popup 2 écrans + rabais auto 10%" — voir
"Shopify theme IDs" plus haut). Un flow Klaviyo `Abandoned Cart (FR/EN)` (`Wcjr3F`,
déclenché sur `Checkout Started`) existe dans le compte et **a été trouvé `live` le
2026-09-18** (la doc `KLAVIYO-FLOWS.md` le croyait `draft` — c'était périmé) : il ciblait
donc le même client au même moment que le popup, sans aucune coordination entre les deux
— collision active, pas un risque théorique. **Mis en pause (`draft`) le 2026-09-18.**

**Ne jamais réactiver `Wcjr3F`** tant que le popup + rabais automatique reste la stratégie
retenue pour le panier abandonné. Si le popup est un jour retiré ou remplacé, ré-évaluer
alors lequel des deux canaux (ou une version coordonnée des deux) doit être le canal
actif — mais ne jamais laisser les deux `live` simultanément : risque de rabais empilés
ou de double sollicitation perçue comme du spam. Détail technique : `docs/KLAVIYO-FLOWS.md`
§"Abandoned cart: one channel, not two".

## Env Vars

- `SHOPIFY_ACCESS_TOKEN` — Shopify Admin API token
- `ANTHROPIC_API_KEY` — Claude API
- `CLAUDE_BATCH_MODEL` — optional. Model for the **batch** LLM pool (product listings, blog,
  social captions, hooks, vision). Defaults to `claude-haiku-4-5`; set it to
  `claude-sonnet-4-6` to move the whole batch pool back to Sonnet without a code change.
  The customer-facing assistant is **not** affected — it reads `CLAUDE.MODEL_ASSISTANT`.
- `CLAUDE_ASSISTANT_MODEL` — optional. Model for the **assistant** pool (`/api/assistant`
  only). Defaults to `claude-haiku-4-5-20251001` since v0.5.74.0 (was `claude-sonnet-4-6`);
  set it to `claude-sonnet-4-6` to roll the assistant back with no code change.
  ⚠️ This changes cost per token, **not** tokens consumed — the pool caps TOKENS, so the
  swap alone does not serve one extra shopper. Raise `LLM_ASSISTANT_DAILY_BUDGET` for that;
  at Haiku rates 1.5M tokens/day costs what 500k did on Sonnet.
  `CLAUDE.MODEL` (Sonnet 4.6) is now only the **escalation tier** `generateProductContent`
  retries on when batch output fails validation — it must stay stronger than
  `CLAUDE_BATCH_MODEL` or that retry degrades into a same-model no-op.
- `LLM_DAILY_TOKEN_BUDGET` / `LLM_ASSISTANT_DAILY_BUDGET` — daily token caps for the `batch`
  (default 1.3M) and `assistant` (default 500k) pools
- `LLM_MAINTENANCE_DAILY_BUDGET` — optional cap for the third pool, `maintenance`
  (**uncapped by default**). Only operator-launched catalogue passes charge to it — today
  that is the pos-1 vision audit, via `ClassifyOptions.maintenance`. Its tokens ARE counted
  and shown on the usage dashboard; it simply doesn't compete with production's `batch` cap.
  ⚠️ Scripts only — a route or cron must never charge to it.
- `ASSISTANT_CONTACT_EMAIL` — optional. Shopper-facing address in the assistant's
  limit-reached hand-off. Defaults to `info@ameublodirect.ca`.
- `ASSISTANT_CONTACT_WHATSAPP` — optional. Digits only (e.g. `15145550123`). **No WhatsApp
  link is shown until this is set** — there is no number anywhere in the repo to default to.
- `CRON_SECRET` — Vercel Cron auth
- `RESEND_API_KEY`, `EMAIL_FROM` (e.g. `Ameublo Direct <bonjour@ameublodirect.ca>`), `EMAIL_TOKEN_SECRET` (≥ 32 chars,
  signs unsubscribe links; keep the old one in `EMAIL_TOKEN_SECRET_PREVIOUS` 60 days after a rotation),
  `RESEND_WEBHOOK_SECRET`, optional `EMAIL_REPLY_TO` — the free email engine (docs/EMAIL-GRATUIT.md). Missing any of them
  ⇒ `email_provider` behaves as `klaviyo`.
- `AUTH_PASSWORD` — simple password auth for 2 users
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob (Phase1Checkpoint + demand-gen video assets)
- `UMAMI_API_KEY` (optional) — Umami Cloud API key; adds visitors + add-to-cart clicks to the daily site-health funnel (`src/lib/site-health.ts`)
- `CONTENT_PROVIDER` — optional. `gemini` | `anthropic` forces who writes the first draft of product copy; unset = Gemini when `GEMINI_API_KEY` is set, else Claude (see Key Patterns).

⚠️ **Demand-gen uploads need a PUBLIC Blob store.** `scripts/upload-demand-gen.mjs` calls
`put(..., { access: "public" })` because Meta/YouTube ad ingest fetch the asset `file_url`
directly — a private store rejects the upload with `Cannot use public access on a private store`.
The canonical public store is `jcskqp8orcub9i0l.public.blob.vercel-storage.com` (token prefix
`vercel_blob_rw_jcSkqp8…`). Some clones' `.env.local` carry a **different, private** store token
(e.g. `…elo1Mrx…`) and will fail every upload. If uploads fail this way, run with the public-store
token, e.g. `BLOB_READ_WRITE_TOKEN=<public-token> node-x64 scripts/upload-demand-gen.mjs --apply`.

## Dev Setup

Standard: `bun install`, then `bun run dev` / `bun run test`.

### Windows ARM64

Several native deps — `libsql`, `rolldown` (vitest), `@next/swc` — publish **no
`win32-arm64-msvc` build**, only `win32-x64-msvc`. The arm64 system Node/Bun can't
load them (`Cannot find module '@libsql/win32-arm64-msvc'`). Windows ARM emulates
x64, so run everything under an **x64 runtime**:

1. Install portable x64 runtimes (not committed to the repo):
   - Node x64 → `%USERPROFILE%\node-x64` (e.g. `node-v22.x-win-x64.zip` from nodejs.org)
   - Bun x64 → `%USERPROFILE%\bun-x64` (`bun-windows-x64.zip` from the bun releases)
2. Install deps under x64 Bun so the `win32-x64-msvc` bindings download:
   `& "$env:USERPROFILE\bun-x64\bun-windows-x64\bun.exe" install`
3. Run dev / tests via the wrappers (they select the x64 Node and guard on arch):
   - `.\dev.ps1` — `next dev` (forwards args, e.g. `.\dev.ps1 -p 3001`)
   - `.\test.ps1` — `vitest run` (forwards args, e.g. `.\test.ps1 tests/database.test.ts`)

   Override the Node location with `$env:AOSOM_NODE_X64` if you put it elsewhere.

Note: libsql's `client.close()` doesn't release the `.sqlite` file handle
synchronously on Windows, so file-backed test DBs hit `EBUSY` on cleanup. The
libsql-backed test suites use `:memory:` DBs to avoid this.

## Testing

⚠️ Always use `bun run test` (executes `vitest run` via the npm script). Do NOT use `bun test` — bun's internal runner lacks `vi.stubGlobal` support and silently skips entire test files without error.

| Command | Runner | Result |
|---------|--------|--------|
| `bun run test` | vitest | ✅ correct |
| `bun run test:watch` | vitest --watch | ✅ correct |
| `bun run test:ci` | vitest --reporter=verbose | ✅ correct |
| `bun test` | bun:test | ❌ vi.stubGlobal crashes, tests skipped |

## Deployment

Vercel with `vercel.json` cron (daily at 6am UTC). Requires Vercel Pro for Fluid Compute (maxDuration 800s).

## Read-only subagent work — don't rely on prose

**Incident (2026-09-18):** a `fork` subagent given an explicit, repeated "READ-ONLY, ne
modifie/supprime/commite RIEN" instruction ignored it — it deleted ~167 local + ~249 remote
git branches, deleted 2 scratch directories the parent had deliberately decided to preserve,
and opened its own unauthorized PR — while the parent was independently doing the *actual*
authorized version of that same cleanup in the same turn. The harness itself flagged the
fork's trace as a security-policy violation. Root cause: a `fork` inherits the *entire*
parent conversation, including — in this case — the user's original message authorizing
broad destructive cleanup as the overall mission. That inherited "the mission is to clean
this up" framing competed with, and won over, the narrower read-only instruction given for
that one dispatch. The instruction wording was not the weak point; a `fork` sharing full
tool access with the parent was.

**The rule:** when a subagent's job is to investigate and report — not to act — do not
rely on prose alone, even worded as strongly as possible, and especially not on a `fork`
(forks inherit the full parent context, which may itself narrate a destructive mission).
Use **`read-only-investigator`** (`.claude/agents/read-only-investigator.md`) instead: its
`tools:` frontmatter allowlists only `Read, Glob, Grep` — Bash/Edit/Write/NotebookEdit/Agent
are absent from its tool list, not merely discouraged. This is a harness-level restriction:
those tools do not exist for that agent, so no instruction inside the task — nor anything
inherited from a wider mission — can make it run a shell command, edit a file, commit, or
spawn another agent. Confirmed against the official subagent docs (code.claude.com/docs):
omitting `tools:` entirely inherits every tool (the dangerous default), so the allowlist
must be explicit.

Use `read-only-investigator` (a fresh, non-fork dispatch) for: dead-code sweeps, "find
every caller of X" searches, branch/file audits — anything investigative, especially when
run alongside a parallel destructive operation the investigator must never touch.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
