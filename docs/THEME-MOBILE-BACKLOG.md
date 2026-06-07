# Backlog UX/Mobile — Thème (prochaine session)

## CONTEXTE
Thème "Copie de Trade v2" (id 160059195497) PAS encore publié.
Feedback de Mat après test mobile réel (iPhone) du 4 juin.
Réviser FR ET EN.

## PAGE D'ACCUEIL — MOBILE

### Header
- Logo plus gros, numéro de téléphone plus petit
- Header : vérifier hiérarchie visuelle mobile

### Héro
- Texte mal lisible sur image de fond (overlay insuffisant)
- "Meublez votre espace intérieur" + "Livraison gratuite au Canada"
  sur 2 lignes distinctes
- Renforcer l'overlay gradient derrière le texte

### Barre de confiance
- Doit tenir sur UNE ligne sans scroll horizontal
  (Livraison gratuite, Retours 30j, Paiement sécurisé, Service)
- Réduire taille texte / icônes sur mobile

### Sections produits (best-sellers, mobilier ext.)
- Trop longues à scroller verticalement
- Convertir en carrousel horizontal (scroll latéral) sur mobile

### Section "Magasinez par catégorie"
- Prend trop d'espace vertical → carrousel ou grille compacte
- Changer l'image "Mobiliers extérieurs et jardins"
  (actuelle = vieux meubles abandonnés, pas attrayant)
  → trouver une vraie belle image patio moderne

### Section "Meubles pour la maison"
- Affiche toujours des meubles enfant → varier
- Option : produits aléatoires OU les plus populaires (stock velocity)

### Sections "Pourquoi nous choisir" + "Évaluations"
- Carrousels actuels avec flèches → activer le SWIPE tactile
  (les gens scrollent au doigt, pas avec les flèches)

### Section Blog
- Prend trop d'espace vertical → compacter le layout

### Section "Comment ça marche"
- Esthétique à retravailler (emojis 1/2/3 basiques → design plus pro)

### Header — lien évaluations
- "Laissez-nous votre avis" → le lien mène à Contact (mauvais)
- Où les avis apparaissent-ils réellement ? À clarifier/corriger

## PAGE PRODUIT — MOBILE

- Footer sticky avec bouton "BUY NOW" / "Acheter maintenant"
- Revoir le layout pour maximiser la conversion
- Ajouter les avis/étoiles Aosom sur les produits si faisable
  (à investiguer : Aosom expose-t-il les ratings dans le feed ?)

## VERSION ANGLAISE
- Réviser toute la version EN (Furnish Direct) en parallèle
- Vérifier que tous les fixes mobile s'appliquent aux 2 langues

## À faire — Suite session 7 juin

### Fix espacement homepage mobile
- Rapprocher la bande Shop Pay (shop_pay_home) de l'image héro
- Rapprocher "Meilleures offres du moment" de la bande Shop Pay
- Réduire le padding/margin entre tous ces blocs sur mobile
- Cible : enchaînement fluide sans grands espaces blancs

### Fix lien Judge.me dans barre d'annonce
- Slide 2 de l'annonce bar pointe vers judge.me/reviews/ameublodirect.myshopify.com
- Ce lien retourne 404
- Trouver la vraie URL publique des avis Judge.me pour ameublodirect.ca
- Options : page /pages/avis, ou désactiver ce slide

### Vercel env vars à confirmer
- META_AD_ACCOUNT_ID=act_20658834 → ajouter en Production + Preview
- META_ACCESS_TOKEN → vérifier qu'il est à jour (long-lived token)
