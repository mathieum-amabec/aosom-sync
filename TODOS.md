# TODOS

## Import Pipeline

### Bulk Generate — Pousser tous les produits vers Shopify en batch

**Priority:** P1 (HIGH)
**Branch:** `feature/bulk-generate`
**Dépendances:** aucune

**Contexte:** La page /import affiche les produits Aosom avec un bouton "Generate" individuel par produit. Avec 10 000+ produits, c'est impossible de les faire un par un.

**Specs:**

1. **Bouton "Generate All"**
   - Un bouton en haut de la page /import, à côté des filtres
   - Texte : "Generate All" ou "Generate All Pending"
   - Style : bouton vert prominent, bien visible
   - Ne génère que les produits avec status "pending" (pas ceux déjà générés)

2. **Sélection partielle (nice to have)**
   - Checkboxes sur chaque produit (comme dans /catalog)
   - Bouton "Generate Selected" qui apparaît quand 1+ produits sont cochés
   - "Select All" checkbox en haut pour tout cocher

3. **Traitement en batch (critique pour la performance)**
   - NE PAS envoyer 10 000 requêtes Shopify en même temps
   - Traiter par batch de 10-25 produits à la fois
   - Respecter les rate limits de l'API Shopify (2 req/sec bucket)
   - File d'attente (queue) pour gérer les batches séquentiellement
   - Si un produit fail, continuer les autres (ne pas tout arrêter)

4. **Progress bar / feedback**
   - Barre de progression : "Generating... 142/10269 (1.4%)"
   - Compteurs live : succès, échecs, en attente
   - Log des erreurs pour les produits qui ont fail
   - Estimation du temps restant
   - Bouton "Stop" pour arrêter le processus en cours

5. **Résumé final**
   - Modal ou notification à la fin : "8,543 générés, 26 erreurs, 1,700 déjà existants"
   - Liste des erreurs avec le nom du produit et la raison
   - Bouton "Retry Failed" pour relancer seulement les erreurs

6. **Protection**
   - Confirmation avant de lancer : "Vous allez générer X produits sur Shopify. Continuer?"
   - Empêcher de lancer 2 bulk generate en même temps
   - Rate limiting pour pas se faire bloquer par Shopify

---

## Performance

### Cold start Vercel sur plan Hobby
**Priority:** P3 (LOW)
**Status:** Mitigé avec UptimeRobot (ping /api/health toutes les 5 min). Le plan Hobby ne supporte pas les crons fréquents. Upgrade au plan Pro résoudrait définitivement.

### Sync timeout sur Vercel
**Priority:** P2 (MEDIUM)
**Status:** Fixé — sync splitté en 2 phases (DB sync 6:00 UTC, Shopify push 6:10 UTC). Fonctionne dans les 300s du plan Hobby.

---

## Sécurité

### Rate limiting sur les endpoints Claude API
**Priority:** P2 (MEDIUM)
**Contexte:** Pas de rate limiting sur /api/import/generate. Un user malveillant pourrait spammer et générer des coûts Claude élevés. In-memory rate limiter resets sur cold starts (Upstash Redis recommandé).

---

## Completed

### Bulk Generate — Pousser tous les produits vers Shopify en batch
**Completed:** v0.1.4.0 (2026-04-11)

### Rate limiting sur les endpoints Claude API
**Completed:** v0.1.4.1 (2026-04-11)
