# Plausible Analytics — Guide d'installation

Plausible.io est une solution d'analytique web **canadienne, sans cookies**, conforme
**RGPD / PIPEDA / Loi 25 (Québec)**. Aucune bannière de cookies n'est requise. Le script
est léger (< 1 KB) et n'impacte pas la vitesse du site.

Ce document décrit la configuration côté Plausible. **Le code est déjà en place** dans le
thème Shopify (copie `160059195497`) et dans le dashboard aosom-sync — voir la section
« Ce qui est déjà fait » plus bas.

---

## ÉTAPE 1 — Créer le compte Plausible (action manuelle de Mat)

1. Aller sur <https://plausible.io> → **Start free trial** (essai 30 jours, sans carte).
   - Plan recommandé après l'essai : **Growth** (~9 $US/mois pour ≤ 10k pages vues/mois).
2. S'inscrire avec un courriel pro (idéalement `info@ameublodirect.ca` ou le courriel
   d'administration de la boutique).
3. Confirmer l'adresse courriel via le lien reçu.

> 💡 Plausible peut aussi être **auto-hébergé** (Community Edition, gratuit, Docker) si on
> veut éviter l'abonnement. Pour démarrer, le SaaS est le plus simple.

---

## ÉTAPE 2 — Ajouter les domaines

Dans Plausible → **Add a website** :

1. **Domaine principal** : `ameublodirect.ca`
   - Timezone : `America/Toronto`
2. (Optionnel mais recommandé) **Add a website** une 2ᵉ fois : `furnishdirect.ca`
   pour suivre la version anglaise séparément.

Le script installé dans le thème déclare **les deux domaines** :

```html
<script defer
  data-domain="ameublodirect.ca,furnishdirect.ca"
  src="https://plausible.io/js/script.tagged-events.js"></script>
```

➡️ Chaque visite est donc envoyée aux **deux** sites Plausible. Crée bien les deux
sites dans Plausible (sinon le 2ᵉ domaine renverra des données ignorées). Si tu ne
veux qu'un seul site, retire `,furnishdirect.ca` du `data-domain` (voir
`scripts/apply-plausible.mjs`).

---

## ÉTAPE 3 — Vérifier que le script est détecté

1. Dans Plausible, sur le site `ameublodirect.ca`, cliquer **Verify your installation**.
2. Ouvrir le storefront (ou l'aperçu du thème `160059195497`) dans un onglet :
   - DevTools → onglet **Network** → filtrer `plausible` → recharger la page.
   - Tu dois voir une requête vers `plausible.io/api/event` avec statut **202**.
3. Plausible affiche « **Success! Your installation is working** » dès la 1ʳᵉ visite.

> ⚠️ Le script est posé sur la **copie de thème `160059195497`** (aperçu non publié).
> Les données ne remonteront en production qu'**après publication de ce thème**.
> Tant que ce n'est pas publié, teste via l'URL d'aperçu du thème.

---

## ÉTAPE 4 — Configurer les objectifs (Goals / events custom)

Le thème envoie déjà 4 events de clic personnalisés (+ les pages vues automatiques).
Dans Plausible → **Site Settings → Goals → + Add goal → Custom event**, créer ces
4 objectifs en saisissant **exactement** le nom de l'event :

| Goal (nom exact)  | Déclencheur                                                    |
| ----------------- | -------------------------------------------------------------- |
| `Hero CTA`        | Clic sur « Magasinez maintenant / Shop now » (héro accueil)    |
| `Sticky ATC`      | Clic sur « Acheter maintenant / Buy now » (barre mobile fixe)  |
| `Messenger Click` | Clic sur le bouton flottant Messenger (`m.me/AmeubloDirect`)   |
| `Add to Cart`     | Soumission du formulaire d'ajout au panier (page produit)      |

> Les **pages vues produit** sont suivies automatiquement (pageviews) — pas besoin
> de goal pour ça. Pour isoler les pages produit, créer au besoin un goal de type
> **Pageview** avec le chemin `/products/**`.

Une fois les goals créés, ils apparaissent dans le tableau de bord avec le nombre de
conversions et le taux de conversion.

> 💡 Optionnel : marquer `Sticky ATC` et `Add to Cart` comme **funnel** (Settings →
> Funnels) pour visualiser héro → panier → checkout.

---

## ÉTAPE 5 — Accéder au tableau de bord

- URL directe : <https://plausible.io/ameublodirect.ca>
- Raccourci intégré : dans **aosom-sync**, lien **« Analytics »** en bas de la barre
  latérale (ouvre Plausible dans un nouvel onglet). Masqué pour le rôle *reviewer*.
- Pour partager un dashboard public en lecture seule : Plausible → Site Settings →
  **Visibility → Public dashboard**.

---

## Ce qui est déjà fait (côté code) ✅

| Élément                         | Emplacement                                                        |
| ------------------------------- | ----------------------------------------------------------------- |
| Script Plausible dans `<head>`  | `layout/theme.liquid` (thème `160059195497`), après `meta-tags`   |
| Stub `window.plausible()`       | même bloc `<head>` (file d'attente avant chargement du script)    |
| Goal `Hero CTA`                 | `templates/index.json` → section `lc_hero`, classe sur `.lc-btn`  |
| Goal `Sticky ATC`               | `templates/product.json` → bouton `#mobile-sticky-atc`            |
| Goal `Messenger Click`          | `layout/theme.liquid` → ancre `.lc-msgr`                          |
| Goal `Add to Cart`              | listener délégué `submit` sur `form[action*="/cart/add"]`         |
| Lien « Analytics »              | `src/components/sidebar.tsx`                                       |
| Script d'application idempotent | `scripts/apply-plausible.mjs` (re-jouable, fait un backup)        |

**Note technique :** on utilise `script.tagged-events.js` plutôt que `script.js`. C'est
un **surensemble** : mêmes pages vues automatiques que `script.js`, plus la prise en
charge des objectifs de clic via la classe CSS `plausible-event-name=<Nom>`. C'est ce
qui permet de suivre les 4 clics ci-dessus sans JavaScript additionnel par bouton.

### Re-jouer / modifier l'intégration thème

```powershell
# depuis C:\Users\vente\Documents\aosom-sync (runtime x64 — voir CLAUDE.md ARM64)
& "$env:USERPROFILE\node-x64\node.exe" scripts/apply-plausible.mjs --dry   # aperçu
& "$env:USERPROFILE\node-x64\node.exe" scripts/apply-plausible.mjs         # appliquer
```

Le script lit le token Shopify depuis `.env.local` (`SHOPIFY_ACCESS_TOKEN`) et cible
la copie de thème `160059195497`. Sauvegardes des assets dans `scripts/reports/`.

---

## Confidentialité / conformité

- **Aucun cookie**, aucune donnée personnelle stockée → pas de bannière de consentement.
- Données hébergées dans l'UE/Canada selon le plan, agrégées et anonymes.
- À mentionner brièvement dans la politique de confidentialité (`/privacy`) : « Nous
  utilisons Plausible Analytics, une solution sans cookies et respectueuse de la vie
  privée, pour mesurer l'audience de façon agrégée et anonyme. »
