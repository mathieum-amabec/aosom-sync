# Plan visibilité IA — novembre 2026

Trois chantiers issus de l'audit SEO/IA du 2026-10-31. Mesure de départ (Shopify, 90 jours au 2026-10-31) :
**23 sessions venues d'une IA** (22 ChatGPT, 1 Gemini), **0 commande**. robots.txt ne bloque aucun robot IA.

---

## 1. Fiches produit en format questions-réponses

**État actuel.** `snippets/agentic-faq.liquid` émet un FAQPage JSON-LD **générique** (livraison, retours,
garantie, montage, entretien — les mêmes réponses sur 3 500 fiches) et les réponses visibles sont dans
l'accordéon `pdp_info`. Rien de propre au produit.

**Pourquoi changer.** Les IA citent des faits précis et vérifiables (dimensions, capacité, poids supporté,
montage, compatibilité). Depuis mai 2026, Google n'affiche plus aucun résultat enrichi FAQ : le balisage ne
sert plus qu'à la compréhension. Ce qui compte, c'est le **texte visible** dans le HTML.

**Ce qu'on construit.**
1. Metafield produit `custom.faq` (JSON `[{q, a}]`, 3 à 5 Q/R), FR sur le produit + EN via traduction.
2. Un gabarit de questions **par type de produit** (≈ 25 gabarits couvrent ~90 % du catalogue) :
   - Abris / serres / gazebos : « Résiste-t-il au vent ? », « Faut-il l'ancrer ? », « Combien de temps pour le monter ? », « Quelles dimensions au sol ? »
   - Foyers électriques : « Quelle surface chauffe-t-il ? », « Peut-on l'utiliser sans chaleur ? », « Quelle prise faut-il ? »
   - Meubles : « Poids maximal ? », « Passe-t-il dans une porte standard ? » (réutilise le fit-checker), « Matériau du dessus ? »
   - Enfants / animaux : « Pour quel âge / quel poids ? », « Normes de sécurité ? »
3. Les réponses sont remplies **uniquement à partir des données du produit** (specs du flux, description) ;
   si la donnée manque, la question est omise. Jamais de promesse hiver/neige non documentée.
4. Thème : la section FAQ lit `custom.faq` ; elle rend le HTML visible **et** le JSON-LD depuis la même boucle.
   Les Q/R génériques (livraison, retours) restent en dessous.
5. Sources des questions : requêtes Search Console en « comment / quel / est-ce que / how / can »,
   questions posées à l'assistant Ameublo (journaux), raisons de retour, « Autres questions posées » de Google.

**Déroulement.**
- Semaine 1 : gabarits + script de génération en dry-run sur les 100 meilleurs vendeurs ; vérification par un agent séparé.
- Semaine 2 : section de thème sur un brouillon ; publication avec OK de Mat ; application aux 100 produits.
- Semaine 3–4 : extension au reste du catalogue par lots de 500, avec dry-run et vérification à chaque lot.
- Ajout au pipeline d'import pour que chaque nouveau produit ait sa FAQ.

**Coût.** Rédaction par Claude/Gemini sur notre budget LLM existant (quelques dollars pour tout le catalogue) — OK de Mat requis avant le lot complet.

**Mesure.** Impressions IA par page dans Search Console (rapport IA générative), citations Bing AI Performance,
sessions IA (voir chantier 3) sur les 100 fiches pilotes contre 100 fiches témoins.

---

## 2. Campagne de mentions (blogues et comparatifs québécois)

**Pourquoi.** Les IA citent surtout Reddit, YouTube et les listes « meilleurs X » ; les détaillants ne
reçoivent qu'environ 3 % des citations. Il n'existe presque **aucun comparatif québécois en français** pour
« meilleur abri d'auto », « meilleure serre », « meilleur foyer électrique » : c'est un trou à prendre.

**Règles.** Transparence totale (Ameublo Direct = détaillant canadien de produits importés), aucun faux avis,
aucune publication anonyme sur Reddit. Ne jamais nommer le fournisseur. Aucune dépense ni contact sans OK de Mat.

**Volet A — notre propre contenu de référence (mois 1).**
- 4 guides d'achat FR + EN sur le blogue, faits vérifiables, tableaux comparatifs :
  « Choisir une serre de jardin au Québec », « Abri de rangement : quelle taille, quel ancrage ? »,
  « Foyer électrique : surface, consommation, sécurité », « Meubles livrés au Québec : ce qu'il faut mesurer avant d'acheter ».
- Ce sont les pages que les IA et les blogueurs citeront.

**Volet B — prises de contact (mois 1–2), 1 courriel personnalisé par cible, rédigé par moi, envoyé par Mat.**

| Priorité | Cible | Angle |
|---|---|---|
| 1 | Narcity Québec | « alternatives abordables » meubles / déco livrés au Québec |
| 1 | Noovo Moi — Style et maison | liste de boutiques en ligne québécoises |
| 1 | Cansumer (« best electric fireplaces Canada »…) | inclusion de produits dans ses listes |
| 1 | House & Home, Cottage Life | serres et remises pour le Canada |
| 2 | Joli Joli Design, Déconome (blogues déco QC) | collaboration produit (1 article prêté contre un avis honnête) |
| 2 | Soumission Rénovation (blogue) | données prix abris / remises |
| 2 | Lemon Thistle, Homenetwork.ca, Interior Insider | inclusion dans « où acheter des meubles au Canada » |
| 2 | Maman pour la vie, SavvyMom | guides cadeaux des Fêtes (enfants, animaux) |
| 3 | Le jardinier paresseux | réponse experte sur les serres (pas de placement payé) |
| 3 | Protégez-Vous | données et expertise seulement (aucune publicité acceptée) |

**Volet C — communautés.**
- Répondre, sous l'identité Ameublo Direct, aux questions sur r/Quebec, r/montreal, r/PersonalFinanceCanada
  quand un produit répond vraiment à la question.
- YouTube : publier les montages et déballages existants avec titres FR-QC (« Montage serre 6x8 »).

**Volet D — preuve sociale.** Avis Judge.me (18 aujourd'hui → objectif 100 d'ici fin janvier) et fiche Google
Business. Les IA répètent la question « ce site est-il fiable ? ».

**Mesure.** Tableau de suivi (cible, date de contact, réponse, lien obtenu), sessions référentes par domaine
dans Shopify, et présence d'Ameublo dans les réponses des IA (chantier 3).

---

## 3. Mesurer le trafic venant de l'IA

**Déjà en place.**
- `src/lib/shop-analytics.ts` classe déjà les visites ChatGPT / Perplexity / Claude / Gemini dans « ChatGPT / IA ».
- Search Console connecté (page /seo).

**À ajouter.**
1. **Rapport hebdomadaire IA** (cron, rapport du matin) — ShopifyQL :
   `FROM sessions SHOW sessions, sessions_that_completed_checkout GROUP BY referrer_domain WHERE referrer_domain IN (chatgpt.com, perplexity.ai, gemini.google.com, copilot.microsoft.com, claude.ai, meta.ai) SINCE -7d`,
   plus les commandes dont la visite d'origine porte `utm_source=chatgpt.com`.
2. **Search Console → rapport « IA générative »** (impressions AI Overviews / AI Mode par page, depuis le 2026-05-18) : à ajouter à la page /seo.
3. **Bing Webmaster Tools → AI Performance** : citations Copilot par requête et par page (gratuit ; on est déjà vérifiés pour IndexNow).
4. **Panel de 30 questions fixes** (FR + EN) posées chaque mois à ChatGPT, Perplexity, Gemini, Copilot et Meta AI
   (« où acheter une serre au Québec », « meilleur foyer électrique livré au Canada »…) ; on note si Ameublo / Furnish
   apparaît et quelle page est citée. Manuel au départ (gratuit) ; outil payant (Otterly ~29 $ US/mois) seulement si Mat le veut.
5. **Robots IA** : journaliser par user-agent les appels à nos points Vercel (llms.txt, flux) pour voir GPTBot,
   OAI-SearchBot, PerplexityBot, ClaudeBot. Shopify ne donne pas les journaux serveur de la boutique.
6. **GA4 (si Mat l'active)** : groupe de canaux « IA » avant « Référent », regex
   `.*(chatgpt\.com|openai\.com|perplexity|gemini\.google\.com|copilot\.microsoft\.com|claude\.ai|meta\.ai|deepseek\.com|grok\.com).*`.

**Objectifs à 90 jours** (référence : 23 sessions / 90 j) : 150 sessions IA / 90 j, au moins 1 commande attribuée,
Ameublo cité dans au moins 5 des 30 questions du panel.
