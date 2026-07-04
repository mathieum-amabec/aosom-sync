# Reviews Automation — état actuel & plan (Judge.me + Klaviyo)

_Audit autonome du 2026-07-04. Lecture seule — aucune écriture Shopify. Ce doc
constate l'état réel (API Judge.me / Klaviyo + storefront live) et documente les
étapes exactes à faire dans les dashboards (non scriptables)._

## TL;DR — recommandation

- **Judge.me est bien installé et connecté au thème, mais il y a 0 avis.** C'est la
  lacune n°1 de conversion (cf. audit stratégique) — surtout pour le trafic froid des
  campagnes DPA Meta.
- **Un flow Klaviyo « Post-Purchase — Review Request » existe ET est `live`** (il envoie
  déjà). Mais il est **mal réglé** : déclenché sur `Placed Order` (à la commande) + 14 j,
  lien vers la page d'accueil (pas de deep link Judge.me), sans incitation photo, sans
  exclusion des commandes annulées/remboursées.
- **Recommandation :** faire des **demandes d'avis natives Judge.me** (déclenchées à
  l'expédition, deep link par produit, upload photo intégré) le **canal canonique**, et
  **désactiver la partie « demande d'avis » du flow Klaviyo** pour éviter le double envoi.
  Amorcer avec un **import CSV éthique** d'avis réels.

---

## OBJECTIF 1 — État Judge.me (vérifié)

| Question | Réponse | Preuve |
| --- | --- | --- |
| Combien d'avis ? | **0** | PDP live : badge `data-number-of-reviews="0"`, `data-average-rating="0.00"` ; page `/pages/avis-clients` rendue mais vide |
| App connectée au thème / widget sur PDP ? | **Oui** | `judgeme-606/assets/loader.js` chargé ; `.jdgm-widget` + `.jdgm-prev-badge` présents sur la PDP ; page « Avis clients » live et liée depuis la barre d'annonce |
| Token API Judge.me stocké ? | **Non** | Aucun `JUDGEME_*` dans `.env.local` ; `scripts/judgeme-token-probe.mjs` ne le trouve pas dans le HTML statique (widget chargé côté client via app-block) |
| Webhook / import déjà fait ? | **Non** | 0 avis = aucun import ; la synchro commandes Judge.me (pour les demandes d'avis natives) est un réglage **dashboard** à vérifier (voir Objectif 2, option A) |

Détail utile : à 0 avis, Judge.me **masque** le badge (`display:none`) — donc le widget
vide n'affiche pas d'étoiles cassées. L'implémentation est correcte ; **il manque juste
le contenu (des avis)**.

---

## OBJECTIF 2 — Automatiser la demande d'avis post-livraison

### Ce qui existe déjà (Klaviyo) — `live`, à corriger ou désactiver

Flow **`Post-Purchase — Review Request (FR/EN)`** — ID `TGfezb`
(`https://www.klaviyo.com/flow/TGfezb/edit`). Construit par
`scripts/setup-klaviyo-flows.mjs`, template `[Flow] Post-Purchase — Avis` (`UpihuQ`).

> ⚠️ Le doc `KLAVIYO-FLOWS.md` le décrit comme `draft` — **c'est périmé, le flow est
> maintenant `live`** (vérifié via `GET /api/flows/TGfezb`). Il envoie déjà des courriels.

| Réglage actuel | Cible souhaitée | Écart |
| --- | --- | --- |
| Trigger `Placed Order` (à la commande) | `Fulfilled Order` (à l'expédition) | ❌ En dropship, la livraison prend 1–3 sem. Avec `Placed Order` + 14 j, **la demande d'avis peut arriver AVANT le colis** |
| Délai **14 j** | **10 j** (après fulfillment) | ⚠️ mineur |
| CTA → `ameublodirect.ca` (accueil) | Deep link Judge.me du produit acheté | ❌ pas de lien direct vers le formulaire d'avis |
| Pas d'incitation photo | Demande de photo | ❌ |
| Pas de filtre | Exclure `Cancelled Order` / `Refunded Order` | ❌ |

Bonne nouvelle : les métriques nécessaires **existent déjà** dans le compte Klaviyo
(vérifié) : `Fulfilled Order`, `Cancelled Order`, `Refunded Order`.

### Option A — Judge.me natif (RECOMMANDÉE) — dashboard `app.judge.me`

Judge.me fait ça mieux que Klaviyo pour la demande d'avis : deep link automatique par
produit acheté, formulaire avec **upload photo/vidéo intégré**, et c'est **inclus dans le
plan gratuit**. Étapes (admin Judge.me) :

1. **Shopify admin → Apps → Judge.me** → ouvrir l'admin de l'app.
2. **Settings → Review requests** (ou « Email → Review request email »).
3. **Activer** « Automatic review request emails ».
4. **Trigger / timing :** régler l'envoi sur **X jours après _fulfillment_** (expédition),
   pas après la commande. Mettre **~10 jours après fulfillment** (ajuster selon le délai
   de livraison réel Aosom ; l'objectif est « quelques jours après réception »).
5. **Exclusions :** Judge.me exclut nativement les commandes non fulfilled ; vérifier
   qu'il n'envoie pas sur commandes annulées/remboursées (option dans les settings de
   review request). Il envoie par produit fulfilled → deep link correct automatiquement.
6. **Template :** personnaliser le courriel (FR québécois, marque Ameublo Direct,
   `info@ameublodirect.ca` comme expéditeur), garder le bouton « Laisser un avis » qui
   ouvre le formulaire avec **photo/vidéo activée**.
7. **Sender / deliverability :** vérifier le domaine d'envoi Judge.me (ou brancher un
   expéditeur vérifié) pour éviter le spam.
8. **Incitation photo (optionnelle, plan payant) :** le **coupon-après-avis-photo** est
   une feature du plan « Awesome ». Sur le plan gratuit, on peut quand même **demander** la
   photo (le formulaire l'accepte) — juste pas de récompense automatisée.

### Option B — Garder Klaviyo (si on préfère le contrôle marque/bilingue)

Si on garde Klaviyo comme canal de review-request au lieu de Judge.me natif, corriger le
flow `TGfezb` dans le dashboard (`.../flow/TGfezb/edit`) :

1. **Changer le trigger** : `Placed Order` → **`Fulfilled Order`**.
2. **Délai** : 14 j → **10 j**.
3. **Flow filter** : ajouter un filtre pour **exclure** les profils ayant `Cancelled Order`
   ou `Refunded Order` (zéro fois sur la commande déclencheuse) — ou un conditional split
   qui sort du flow si annulé/remboursé.
4. **CTA** : remplacer le lien accueil par le **deep link Judge.me** du produit
   (`{{ event.extra.line_items }}` → lien formulaire d'avis) ou, à défaut, la page
   `/pages/avis-clients`.
5. **Photo** : ajouter une phrase incitant à joindre une photo.
6. Envoyer un **test** (FR + EN), vérifier rendu mobile + liens, puis laisser `live`.

### ⚠️ Ne PAS double-envoyer

Si **Judge.me natif** ET **Klaviyo** demandent tous deux un avis, chaque client reçoit
**deux** courriels → perçu comme du spam, taux de désabonnement en hausse.
**Choisir UN canal :**
- Si Option A (Judge.me natif) → **désactiver la partie review-ask du flow Klaviyo**
  (mettre `TGfezb` en `draft`/`manual`, ou le convertir en simple « merci + cross-sell »
  sans demande d'avis).
- Si Option B (Klaviyo) → **garder les review requests Judge.me désactivées**.

**Reco : Option A** (Judge.me natif) — plus simple, deep link + photo natifs, gratuit ;
c'est aussi la direction que `KLAVIYO-SETUP.md` privilégiait déjà.

---

## OBJECTIF 3 — Import d'avis initial (amorçage éthique)

Judge.me **permet l'import CSV** (inclus dans le plan gratuit) — utile pour amorcer la
preuve sociale pendant que les avis natifs s'accumulent.

**Procédure (dashboard `app.judge.me`) :**
1. **Settings → Import/Export → Import reviews (CSV)**.
2. Télécharger le **modèle CSV** de Judge.me. Colonnes typiques : `title`, `body`,
   `rating` (1–5), `review_date`, `reviewer_name`, `reviewer_email`, `product_handle`
   (ou `product_id`/`sku` — doit matcher un produit Shopify existant), `picture_urls`
   (URLs séparées par des virgules pour les photos).
3. Mapper chaque avis au bon produit via le **handle Shopify** (nos handles FR, ex.
   `ensemble-meubles-patio-4-pieces-...`).
4. Uploader le CSV → Judge.me crée les avis et les rattache aux PDP.

**⚠️ Éthique (exigence explicite) :** n'importer que des **avis réels** dont on a le
droit :
- ✅ Avis authentiques d'un **autre canal de vente** où on a vendu le même produit
  (ex. notre propre boutique marketplace / Amazon / Etsy, avec le consentement/attribution).
- ✅ Avis fournis par le fournisseur **s'ils sont réels et vérifiables**.
- ⚠️ L'import « AliExpress / autre magasin » proposé par Judge.me copie des avis du
  **produit** (pas de notre magasin) — zone grise : à n'utiliser que si authentiques et
  conforme aux CGU/loi (au Québec/Canada, un faux avis est une pratique trompeuse). En cas
  de doute, **s'abstenir** et miser sur la collecte native.
- ❌ **Jamais** d'avis fabriqués.

---

## Checklist — qui fait quoi

**Toi (dashboards, non scriptable) :**
- [ ] Judge.me → activer les **review requests natives** (trigger fulfillment, ~10 j,
      photo activée) — Option A.
- [ ] Klaviyo → **désactiver** la demande d'avis du flow `TGfezb` (éviter le double envoi),
      ou le corriger si on choisit l'Option B.
- [ ] Judge.me → **import CSV** d'avis réels pour amorcer (Objectif 3).
- [ ] Vérifier l'authentification du domaine d'envoi (Judge.me et/ou Klaviyo).

**Déjà en place (aucune action) :**
- [x] Judge.me installé + widget PDP + page « Avis clients » live.
- [x] Intégration Shopify→Klaviyo avec métriques `Fulfilled/Cancelled/Refunded Order`.
- [x] Structure du flow Klaviyo review-request (à re-router, pas à recréer).
