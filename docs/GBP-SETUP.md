# Google Business Profile (GBP) — Guide d'installation

Pipeline hebdomadaire : sélection produit par trend score → génération du texte (Claude,
ton direct/sans survente) → contrôle qualité (backstop marque + juge Claude) → post stocké
en attente → publication réelle seulement après ton approbation explicite.

**Le code est déjà en place** (`src/lib/gbp-client.ts`, `gbp-post-generator.ts`,
`gbp-publish.ts`, cron `/api/cron/gbp-post`, routes `/api/gbp/posts/*`). Ce qui manque, c'est
la partie que **seul Google peut approuver** — voir Étape 2, c'est le vrai goulot
d'étranglement, pas le code.

---

## ⚠️ Étape 0 — Ce n'est PAS une API self-serve comme Meta

Contrairement à l'API Graph de Meta (utilisée pour Facebook/Instagram), écrire des posts sur
Google Business Profile exige une **demande d'accès approuvée par Google** — pas juste une clé
API qu'on génère soi-même. Le formulaire exige :
- un profil GBP **vérifié et actif depuis 60+ jours**,
- un vrai site web d'entreprise,
- un cas d'usage légitime décrit dans la demande.

L'approbation prend **de quelques jours à quelques semaines**, pas instantané. Tant que ce
n'est pas approuvé, tout le pipeline peut tourner et remplir la table `gbp_posts` en
`pending_review`, mais **aucune publication réelle n'est possible** — `gbp-client.ts` échoue
proprement (erreur claire) plutôt que de planter silencieusement.

Démarre cette demande le plus tôt possible, en parallèle du reste — c'est elle qui dicte le
calendrier, pas le code.

---

## Étape 1 — Créer/réutiliser le projet Google Cloud

Si un projet Cloud existe déjà pour Google Ads (`GOOGLE_ADS_CLIENT_ID` dans `.env.local`), tu
peux **réutiliser le même client OAuth** — active juste l'API Business Profile dessus. Sinon :

1. [console.cloud.google.com](https://console.cloud.google.com) → nouveau projet (ou existant).
2. **APIs & Services → Library** → cherche « Business Profile APIs » (My Business Business
   Information API, My Business Account Management API) → **Enable**.

---

## Étape 2 — Demander l'accès API (le vrai goulot d'étranglement)

1. [support.google.com/business/workflow/16726127](https://support.google.com/business/workflow/16726127)
   → remplir le formulaire de demande d'accès.
2. Décrire l'usage : publication automatisée de posts hebdomadaires basés sur les tendances de
   stock/prix, pour le profil Ameublo Direct (Service Area Business, Québec).
3. Attendre l'approbation (jours à semaines). **Rien d'autre n'avance sans ça.**

---

## Étape 3 — Identifiants OAuth

Si tu réutilises le client Ads existant, cette étape est déjà faite — passe à l'étape 4 avec
les mêmes `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` (le code les utilise
automatiquement en fallback, voir `src/lib/config.ts`).

Sinon : **APIs & Services → Credentials → Create Credentials → OAuth client ID** → type
« Desktop app » (pas « Web », sinon `gbp-oauth.mjs` ne fonctionnera pas — même contrainte que
pour Google Ads, voir `docs/GOOGLE-ADS-SETUP.md`).

---

## Étape 4 — Obtenir le refresh token

```powershell
# depuis C:\Users\vente\Documents\aosom-sync
& "$env:USERPROFILE\node-x64\node.exe" scripts/gbp-oauth.mjs url
# ouvre l'URL affichée, connecté avec le compte Google qui gère le profil Ameublo Direct
& "$env:USERPROFILE\node-x64\node.exe" scripts/gbp-oauth.mjs exchange <code>
```

Copie le refresh token affiché dans `.env.local` :

```dotenv
GOOGLE_GBP_REFRESH_TOKEN=<refresh token>
# Seulement si tu n'utilises PAS déjà GOOGLE_ADS_CLIENT_ID/_SECRET :
# GOOGLE_GBP_CLIENT_ID=...
# GOOGLE_GBP_CLIENT_SECRET=...
```

Vérifie que ça fonctionne (échoue proprement avec un message clair si l'accès API n'est pas
encore approuvé) :

```powershell
& "$env:USERPROFILE\node-x64\node.exe" scripts/gbp-oauth.mjs whoami
```

---

## Étape 5 — Account ID et Location ID

`whoami` liste les comptes accessibles. Trouve le `name` du format `accounts/{id}` pour
Ameublo Direct, puis liste ses `locations` (même API, `GET /v4/accounts/{id}/locations`) pour
le `locations/{id}` du profil (Service Area Business — une seule location normalement).

```dotenv
GOOGLE_GBP_ACCOUNT_ID=accounts/1234567890
GOOGLE_GBP_LOCATION_ID=locations/9876543210
```

---

## Étape 6 — Activer l'automatisation (optionnel, après avoir vu quelques posts)

Par défaut, `GBP_AUTO_PUBLISH` est absent/false : le cron hebdomadaire génère et stocke
toujours en `pending_review`, rien ne part sans un clic d'approbation manuel (voir
`/api/gbp/posts` + `/api/gbp/posts/:id/approve`). **Le tout premier post exige en plus
`confirmFirstPost: true` explicitement, peu importe ce flag** — voir `gbp-publish.ts`.

Une fois que Mat a vu quelques posts réels et approuve le principe :

```dotenv
GBP_AUTO_PUBLISH=true
```

Le cron publiera alors automatiquement les posts dont le score du juge Claude est ≥ 80
(`AUTO_PUBLISH_MIN_SCORE` dans `gbp-post-generator.ts`) — sauf le tout premier, qui reste
bloqué sur l'approbation manuelle même avec ce flag actif.

---

## Cadence

Cron hebdomadaire : lundi 16:00 UTC (`vercel.json`, `/api/cron/gbp-post`), protégé par
`CRON_SECRET` comme tous les autres crons.
