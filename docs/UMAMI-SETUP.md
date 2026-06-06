# Umami Analytics — Guide d'installation

Umami Cloud est une solution d'analytique web **sans cookies**, conforme **Loi 25 (Québec) /
RGPD / PIPEDA**. Aucune bannière de cookies n'est requise. Le forfait gratuit couvre
**100 000 events/mois** — largement suffisant pour ameublodirect.ca.

> **Pourquoi Umami plutôt que Plausible ?** Plausible est payant (9 $US/mois minimum).
> Umami Cloud offre les mêmes garanties (cookieless, agrégé, Loi 25) gratuitement jusqu'à
> 100k events/mois. On a donc remplacé Plausible par Umami.

Ce document décrit la configuration côté Umami. **Le code est déjà en place** dans le thème
Shopify (copie `160059195497`) et dans le dashboard aosom-sync — voir « Ce qui est déjà
fait » plus bas. Il ne reste qu'à créer le compte et coller le `website-id`.

---

## ÉTAPE 1 — Créer le compte Umami (action manuelle de Mat)

1. Aller sur <https://cloud.umami.is> → **Sign up** (gratuit, sans carte).
2. S'inscrire avec un courriel pro (idéalement `info@ameublodirect.ca`).
3. Confirmer l'adresse courriel.

> 💡 Umami peut aussi être **auto-hébergé** (open source, gratuit, Docker + Postgres) si on
> veut tout garder en interne. Pour démarrer, Umami Cloud est le plus simple.

---

## ÉTAPE 2 — Ajouter le website

Dans Umami → **Settings → Websites → + Add website** :

1. **Name** : `Ameublo Direct`
2. **Domain** : `ameublodirect.ca`
3. **Save**.

---

## ÉTAPE 3 — Copier le website-id

1. Toujours dans **Settings → Websites**, cliquer sur le site `ameublodirect.ca` → **Edit**.
2. Copier le **Website ID** (un UUID, ex. `a1b2c3d4-5678-90ab-cdef-1234567890ab`).
   - Tu peux aussi le voir dans le snippet « Tracking code » fourni par Umami.

---

## ÉTAPE 4 — Remplacer le placeholder dans le thème

Le thème contient déjà le script Umami avec un placeholder bien visible :

```html
<script defer src="https://cloud.umami.is/script.js"
  data-website-id="UMAMI_WEBSITE_ID_PLACEHOLDER"></script>
```

Remplace `UMAMI_WEBSITE_ID_PLACEHOLDER` par le vrai Website ID. Deux façons :

**Option A — via le script (recommandé, reproductible)**
Ajoute le Website ID dans `.env.local` (gitignored), puis relance le script — il lit
`UMAMI_WEBSITE_ID` depuis `.env.local` et l'injecte dans le thème :

```dotenv
# .env.local
UMAMI_WEBSITE_ID=a1b2c3d4-5678-90ab-cdef-1234567890ab
```

```powershell
# depuis C:\Users\vente\Documents\aosom-sync (runtime x64 — voir CLAUDE.md ARM64)
& "$env:USERPROFILE\node-x64\node.exe" scripts/apply-umami.mjs --dry   # aperçu
& "$env:USERPROFILE\node-x64\node.exe" scripts/apply-umami.mjs         # appliquer
```

> ✅ Comme l'id vient de `.env.local` et non d'une constante codée en dur, **relancer le
> script préserve le vrai id** (il ne le réécrit jamais en placeholder). Tant que
> `UMAMI_WEBSITE_ID` n'est pas défini, le script écrit le placeholder et **avertit
> bruyamment** que Umami renverra des 404 (aucune donnée) jusqu'à ce que l'id soit fourni.

**Option B — manuellement dans l'éditeur de thème Shopify**
Admin Shopify → **Thèmes → « Copie de Trade v2 » (160059195497) → … → Modifier le code →
`layout/theme.liquid`**, cherche `UMAMI_WEBSITE_ID_PLACEHOLDER`, remplace, **Enregistrer**.

---

## ÉTAPE 5 — Les events custom (automatiques)

Le thème envoie déjà **4 events de clic** personnalisés (+ les pages vues automatiques).
Contrairement à Plausible, **aucune création de goal manuelle n'est nécessaire** : dès qu'un
event est reçu, il apparaît dans Umami sous **Dashboard → (site) → Events**.

| Event (nom)       | Déclencheur                                                       | Mécanisme            |
| ----------------- | ---------------------------------------------------------------- | -------------------- |
| `Hero CTA`        | Clic sur « Magasinez maintenant / Shop now » (héro accueil)      | `data-umami-event`   |
| `Messenger Click` | Clic sur le bouton flottant Messenger (`m.me/AmeubloDirect`)     | `data-umami-event`   |
| `Sticky ATC`      | Clic sur « Acheter maintenant / Buy now » (barre mobile fixe)    | `umami.track()` (JS) |
| `Add to Cart`     | Ajout au panier depuis la fiche produit (`<product-form>` Dawn)  | `umami.track()` (JS) |

Les **pages vues** (dont les pages produit) sont suivies automatiquement.

---

## ÉTAPE 6 — Vérifier l'installation

1. **Publier** le thème copie `160059195497` (ou utiliser son URL d'aperçu). Umami ne
   reçoit des données qu'une fois le script servi par le storefront.
2. Ouvrir le storefront, puis dans Umami → **Dashboard** : les visites en temps réel
   (**Realtime**) doivent apparaître en quelques secondes.
3. Vérifier le script côté navigateur : DevTools → **Network** → filtrer `umami` → recharger.
   Tu dois voir `cloud.umami.is/script.js` (200) puis des requêtes `api/send` (202/200) à
   chaque page vue et chaque event.
4. Tester les events : clique le bouton héro, le Messenger, ajoute au panier, et utilise la
   barre mobile « Acheter maintenant » → ils apparaissent dans **Events**.

> ⚠️ Tant que le thème `160059195497` n'est pas publié, teste via son **URL d'aperçu**.

---

## ÉTAPE 7 — Accéder au tableau de bord

- URL : <https://cloud.umami.is>
- Raccourci intégré : dans **aosom-sync**, lien **« Analytics »** en bas de la barre latérale
  (ouvre Umami dans un nouvel onglet). Masqué pour le rôle *reviewer*.
- Pour partager un dashboard public en lecture seule : Umami → site → **Settings → Enable
  share URL** (génère un lien `cloud.umami.is/share/...`). Tu peux ensuite mettre ce lien
  dans `UMAMI_DASHBOARD_URL` (`src/components/sidebar.tsx`) si tu préfères pointer le lien
  « Analytics » directement sur le dashboard partagé.

---

## Ce qui est déjà fait (côté code) ✅

| Élément                         | Emplacement / mécanisme                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| Script Umami dans `<head>`      | `layout/theme.liquid` (thème `160059195497`), bloc balisé après `meta-tags`   |
| Placeholder website-id          | `data-website-id="UMAMI_WEBSITE_ID_PLACEHOLDER"` (à remplacer, ÉTAPE 4)        |
| Event `Hero CTA`                | `templates/index.json` → `lc_hero`, `data-umami-event` sur `.lc-btn`           |
| Event `Messenger Click`         | `layout/theme.liquid` → `data-umami-event` sur `.lc-msgr`                      |
| Event `Sticky ATC`              | JS dans `<head>` : `umami.track()` + failsafe 500 ms avant submit             |
| Event `Add to Cart`             | JS dans `<head>` : `submit` délégué, limité aux `<product-form>` (Dawn)       |
| Lien « Analytics »              | `src/components/sidebar.tsx` → `https://cloud.umami.is`                        |
| Script de migration idempotent  | `scripts/apply-umami.mjs` (re-jouable, balises de bloc, fait un backup)        |

**Notes techniques :**

- Les **liens `<a>`** (héro, Messenger) utilisent `data-umami-event="<Nom>"` : Umami lie
  automatiquement le clic. Méthode déclarative, robuste.
- Le **bouton Sticky ATC** soumet un `<form>` classique qui fait un **POST pleine page**
  vers `/checkout`. Un `data-umami-event` sur un bouton qui navigue **perd souvent l'event**
  (la page se décharge avant l'envoi). On le gère donc en JS : on bloque la soumission, on
  appelle `umami.track('Sticky ATC')` et on re-soumet sur sa promesse (plus un failsafe de
  500 ms si Umami est bloqué/non chargé). **Le checkout n'est jamais bloqué.** Limite : Umami
  n'a pas de file d'attente avant chargement, donc un clic survenant **avant** que le script
  `defer` ne soit chargé n'est pas compté (cas rare — le script charge tôt). Le failsafe
  garantit quand même la soumission du formulaire.
- **Add to Cart** est limité aux ajouts via `<product-form>` (flux `fetch` de Dawn, sans
  navigation) : pas de perte d'event et pas de double comptage avec le Sticky ATC.
- Umami n'a pas de file d'attente avant chargement, donc chaque appel JS est gardé par
  `typeof window.umami.track === 'function'`.

---

## Confidentialité / conformité

- **Aucun cookie**, aucune donnée personnelle stockée → pas de bannière de consentement.
- Données agrégées et anonymes.
- À mentionner brièvement dans la politique de confidentialité (`/privacy`) : « Nous
  utilisons Umami Analytics, une solution sans cookies et respectueuse de la vie privée,
  pour mesurer l'audience de façon agrégée et anonyme. »
