# A5 — Bloc infolettre en double sur la page d'accueil (analyse)

**Store:** 27u5y2-kp.myshopify.com · **Thème live:** `160059195497` (NE PAS éditer)
**Statut:** analyse terminée — **EN ATTENTE de validation Mat avant toute suppression.**

## Les deux blocs (tous deux des sections Shopify natives `newsletter`)

Correction d'hypothèse : ils ne sont **pas tous les deux dans `index.json`**. L'un est dans
le template home, l'autre dans le groupe footer (visible partout).

### Bloc A — corps de la home
- Fichier: `templates/index.json` → section `lc_newsletter` [type `newsletter`]
- Position: **15/18** dans l'ordre home (vers le bas, après `lc_howit`, avant `lc_trust`)
- Titre: **« Restez à l'affût »**
- Paragraphe: « Inscrivez-vous et recevez nos meilleures offres + conseils déco. »
- Réglages: `full_width:true, color_scheme:scheme-3`

### Bloc B — footer (toutes les pages)
- Fichier: `sections/footer-group.json` → section `newsletter_DPwWK7` [type `newsletter`]
- Position: juste au-dessus du footer, **sur chaque page du site**
- Titre: **« Abonnez-vous gratuitement »** (taille h1)
- Paragraphe: « Faites partie des premières personnes à être informées des nouvelles
  collections et des offres exclusives. »
- Réglages: `full_width:true`

Sur la **home**, les deux se retrouvent empilés en bas (A dans le corps, B juste en dessous
dans le footer) → c'est le doublon perçu.

## Intégration Klaviyo : non affectée

Le rendu live n'a **aucun formulaire Klaviyo injecté par JS** (0 `klaviyo-form`, pas de
`klaviyo.js` onsite). Les deux blocs sont des `email_form` **natifs Shopify** : ils créent un
client Shopify avec consentement marketing, et l'intégration Shopify→Klaviyo (compte XAvTkS,
double opt-in géré dans les réglages de liste Klaviyo) synchronise ce client. **Supprimer un
des deux blocs natifs ne touche donc pas Klaviyo** — la collecte continue via le bloc restant.

## Recommandation

**Garder le bloc B (footer `newsletter_DPwWK7`), supprimer le bloc A (`lc_newsletter` du
corps de la home).**

Pourquoi:
- Le footer est **site-wide** : le retirer ferait perdre l'inscription sur toutes les autres
  pages. On le garde.
- Le bloc A ne fait qu'ajouter une 2e inscription **sur la home uniquement**, juste au-dessus
  de celle du footer → c'est lui le doublon. Le retirer élimine la redondance sans rien perdre
  ailleurs.

*Variante si tu préfères un CTA infolettre plus haut/visible sur la home:* garder A et le
**remonter** (ex. avant `why_us`), et retirer B du footer — mais ça supprime l'inscription
des autres pages. Non recommandé.

## ⚠️ Blocage d'exécution à lever avant la suppression

La consigne interdit d'éditer le thème live `160059195497` et impose de travailler sur une
**copie preview**. Or :
- Il n'existe pas de copie preview à jour du live (les thèmes non publiés `Trade v1/v2`,
  `Clarity`, `Horizon` sont d'anciennes bases, pas une copie du live actuel).
- L'**API Shopify ne sait pas dupliquer** un thème (pas de mutation `themeDuplicate`; le
  `POST /themes.json` exige une URL de `.zip` publique).

**Donc, pour appliquer la suppression sans toucher le live, il faut d'abord une copie preview,
créée manuellement en admin** (Online Store → Themes → ⋯ → **Duplicate** sur « Copie de Trade
v2 »). Une fois la copie créée, donne-moi son **theme id** et j'applique l'édition dessus
(retirer `lc_newsletter` de `templates/index.json` + son entrée `order`), PUT, vérif preview,
puis PR.

## STOP — validation requise

Avant toute suppression, confirme :
1. **Quel bloc retirer** (recommandé: A, le `lc_newsletter` du corps de la home).
2. **Comment gérer le thème preview** (dupliquer le live en admin et me donner le theme id,
   OU m'autoriser une autre approche).

Aucune modification n'a été appliquée. Ce document est l'étape d'analyse du chantier A5.
