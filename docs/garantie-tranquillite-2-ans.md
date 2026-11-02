# Garantie Tranquillité Ameublo — 2 ans (BROUILLON pour l'avocat)

> **Statut : brouillon, NON publié.** Rien n'est vendu tant que l'avocat n'a pas validé ce texte
> et l'avis légal ci-dessous. Rédigé le 2026-11-02 à la suite de l'audit panier/paiement.
> Les passages marqués **[À VALIDER]** sont des points où je ne suis pas certain du droit.

## Contexte pour l'avocat

- Ameublo Direct (Québec) vend en ligne des meubles expédiés par ses fournisseurs (Aosom, Costway).
- Garantie actuelle, incluse : 1 an contre les défauts de fabrication ou de matériaux (politique de remboursement).
- Projet : une **garantie supplémentaire payante, optionnelle**, de 24 mois, vendue par Ameublo et
  **honorée par Ameublo elle-même** (aucun assureur, aucun tiers). Prix : environ 10 % du prix de l'article,
  par paliers (ex. article de 119,99 $ → garantie de 12 $).
- Elle ne couvre **pas** les dommages accidentels (pour ne pas devenir un produit d'assurance — cf. entente
  AMF / AppleCare+ 2023). **[À VALIDER]** que ce périmètre la garde hors de la Loi sur la distribution de
  produits et services financiers.
- Un concurrent direct (ameublementarabais.ca) vend déjà une « Protection de 2 ans » à 5 % via l'app Warranly.

## 1. Avis obligatoire avant l'offre (LPC art. 228.1, Règlement art. 91.9 et 91.10)

Affiché **avant** la case à cocher, sur la fiche produit, lisible sans clic, et repris sur la page de la garantie
(imprimable). **[À VALIDER] : remplacer ce paragraphe par le texte réglementaire exact en vigueur**, y compris
toute mise à jour liée au projet de loi 29 (avis sur les garanties légales, en vigueur le 5 octobre 2026).

> **Avis sur la garantie légale.** La Loi sur la protection du consommateur accorde une garantie sur le bien
> que vous achetez : il doit pouvoir servir à son usage normal pendant une durée raisonnable (articles 37 et 38
> de la Loi). Cette garantie légale s'applique gratuitement, sans que vous ayez à acheter de garantie
> supplémentaire. Ce produit est également couvert sans frais par la garantie Ameublo de 1 an contre les
> défauts de fabrication. Avant d'acheter une garantie supplémentaire, vérifiez si elle vous apporte une
> protection au-delà de ces garanties.

## 2. Ce que la garantie ajoute (ce qui la distingue de la garantie légale)

Pendant **24 mois** à compter de la livraison, pour l'article couvert :

1. **Réparation ou remplacement sans débat sur la « durée raisonnable »** : si l'article ou une de ses pièces
   se brise ou cesse de fonctionner lors d'un usage domestique normal, nous le prenons en charge, sans que vous
   ayez à démontrer un vice caché ou la durée de vie attendue du bien.
2. **Pièces et quincaillerie expédiées gratuitement** (vis, roulettes, vérins, charnières, mécanismes,
   coussins de remplacement lorsque disponibles), à domicile.
3. **Si l'article n'est pas réparable** : remplacement par le même article ou un article équivalent; s'il n'est
   plus offert, crédit ou remboursement du prix payé pour l'article.
4. **Aucuns frais de retour** ni frais de manutention pour un article pris en charge par la garantie.
5. **Réclamation simple** : numéro de commande + photo ou vidéo à info@ameublodirect.ca, réponse en 2 jours
   ouvrables.

## 3. Exclusions

- Dommages accidentels (chute, impact, déversement, taches, brûlures, animaux).
- Usage commercial, locatif ou institutionnel.
- Modifications, réparations faites par un tiers, assemblage non conforme à la notice.
- Usure esthétique normale (décoloration au soleil, boulochage léger) et dommages dus aux intempéries pour un
  meuble d'intérieur utilisé à l'extérieur.
- Articles vendus « tel quel » / liquidation finale **[À VALIDER : les exclure de l'offre plutôt que de la garantie]**.

## 4. Conditions

- S'applique à **un** article (une unité); une garantie par article acheté.
- Acheteur original, adresse de livraison au Canada.
- **Annulation** : remboursement intégral de la garantie sur demande dans les 30 jours suivant la livraison,
  si aucune réclamation n'a été faite. Si l'article est retourné, la garantie est remboursée en entier.
  **[À VALIDER : règles d'annulation au prorata exigées ou non après 30 jours.]**
- La garantie supplémentaire **s'ajoute** à la garantie légale et à la garantie Ameublo de 1 an; elle ne les
  remplace ni ne les limite.
- Taxes applicables sur le prix de la garantie **[À VALIDER : TPS/TVQ sur un contrat de garantie vendu par le
  commerçant]**.

## 5. Prix (paliers)

Prix de la garantie = 10 % de la borne haute du palier de 10 $ dans lequel tombe le prix de l'article
(ex. 110,01 $ à 120,00 $ → 12,00 $). Articles de plus de 2 000 $ : non offerte (aucun dans le catalogue
actuellement) **[à confirmer]**.

## 6. Mise en œuvre prévue (technique)

- Produit Shopify interne « Garantie Tranquillité 2 ans », un variant par palier, non expédié, non suivi en
  stock, exclu des flux Google/Meta, de la synchro fournisseurs et des automatismes de prix.
- Case à cocher **décochée par défaut** sous le bouton d'achat, avec l'avis de la section 1 visible au-dessus.
- La ligne garantie est liée à l'article (propriété « Pour : <article> »); si l'article est retiré du panier,
  la garantie l'est aussi.
- Page publique « Garantie Tranquillité » (FR/EN) reprenant ce texte, imprimable.
- Activation : seulement après validation de l'avocat (réglage du thème + produit actif).
