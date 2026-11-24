# Posts « sujet chaud » (Facebook) — version 2

Un post de jasette, 2 fois par semaine, sur un sujet que **les gens connaissent déjà** (le Canadien, la
première bordée, les pneus d'hiver, le Vendredi fou…) pour faire commenter la page. La carte **nomme
toujours le sujet** : on comprend de quoi on parle sans lire d'article. **Rien ne se publie sans
approbation humaine.**

Exemple de carte (rouge, texte blanc) :

> Le Canadien a perdu 3-4 contre les Flyers de Philadelphie samedi soir.
> ———
> **Il manque de profondeur, ou c'est juste un mauvais soir?**

## Deux types de posts, en alternance

Chaque semaine, le type pas encore utilisé passe en premier (actualité, puis calendrier).

| Type | Source | LLM ? |
|---|---|---|
| `news` — actualité nommée | Journal de Montréal (hockey, sports, spectacles), La Presse (hockey, sports, arts), **API de la LNH** (pointage du dernier match, prochain match). Seulement des nouvelles **datées** et récentes (≤ 30 h sports, ≤ 48 h culture). | oui (tier « strong ») |
| `calendar` — calendrier | Banque écrite d'avance (`src/lib/hot-topics/calendar.ts`) : pneus d'hiver (1er déc.), Vendredi fou, sapin de Noël, réveillon, Boxing Day, Jour de l'An, Saint-Valentin, changements d'heure, poisson d'avril, fêtes des mères/pères, déménagement du 1er juillet, Halloween, thermostat l'hiver. Dates flottantes calculées. | non |

Google Trends n'est **plus une source** : il sert seulement de marqueur de popularité (une manchette qui
correspond à une recherche en tendance passe devant). Google Actualités RSS reste exclu (conditions :
lecteur personnel seulement). On ne reprend que des **manchettes comme inspiration** pour une question
originale — aucun contenu d'article.

## Flux

```
/api/cron/hot-topics (mar + jeu 11:00 UTC)
  type du jour (alternance) ─┬─ calendar : post de la banque, actif aujourd'hui, pas répété (10 j)
                             └─ news : sources fraîches ─► liste noire DURE (avant le LLM)
                                        ─► LLM « strong » : choisit, NOMME le sujet, écrit
                                        ─► validation en code (voir plus bas)
  carte PNG (sharp) ─► Blob public ─► facebook_drafts (hot_topic, 'draft', topic_meta)
                                             │
              /drafts → filtre « Sujets chauds » → panneau « source » → approuver
                                             │
                    publication_queue (notAfter) ─► /api/cron/publisher ─► revérification ─► publication
```

## Ce que le code vérifie (le modèle ne peut pas y échapper)

Pour un post `news` :

1. **Sujet nommé** : le modèle renvoie `subject` ; il doit figurer dans la manchette/contexte **et** sur la
   carte (`fact_line`). Plus de « Gros coup du CH! ».
2. **Rien d'inventé** : tout chiffre et tout nom propre en milieu de phrase doit venir de la source.
3. **Fait officiel** (pointage LNH) : la phrase de la carte est écrite par le code, pas paraphrasée.
4. Catégorie permise, question avec « ? », longueurs, 1 emoji max, pas de hashtag, pas de nom de fournisseur,
   pas d'appât à engagement (commente, partage, identifie, « en commentaires », vote…).
5. **Liste noire à deux niveaux** (`safety.ts`) :
   - **dure** (politique, religion, guerre/immigration, tragédies, santé, justice, argent sensible) : écarte le
     candidat avant le modèle et rejette tout post qui en contient un mot. Les mots simples couvrent aussi
     pluriel/féminin ; « mort de rire » et « mort subite » sont des expressions permises.
   - **à vérifier** (blessure, suspension, rumeur, bagarre, urgence…) : la manchette peut inspirer un post,
     mais le post ne peut pas contenir ces mots, le brouillon est **marqué ⚠** pour toi et passe après les
     sujets sans drapeau.
6. **Noms de personnes** : une équipe, un événement, une émission se nomment librement ; une personne
   seulement pour une décision ou une performance de jeu tirée de la manchette (consigne du modèle). Les
   faits de la LNH ne nomment que des équipes.

Pour un post `calendar` : mêmes validations de texte (testées sur chaque jour de chaque fenêtre, 5 ans).

## À l'approbation et à la publication

- `/drafts` affiche un panneau **« Sujet chaud — source »** : manchette (lien), date de parution, sujet nommé,
  drapeaux sensibles, heure de péremption, pourquoi.
- Le brouillon porte `topic_meta.expiresAt` (nouvelle +48 h après la source ; compte à rebours = fin de sa
  dernière journée ; « ce soir » = mise au jeu). Le temps de file peut être de plusieurs jours : à la
  publication, `notAfter` est revérifié (file **et** bouton « Publier ») et la légende repasse la liste noire
  dure. Un sujet périmé échoue avec « Sujet chaud périmé » au lieu de partir en retard.

## Réglages (table `settings`)

| Clé | Valeurs | Défaut |
|---|---|---|
| `hot_topics_mode` | `off` · `dry` (génère, ne stocke rien) · `live` (crée 1 brouillon par passage) | `off` |
| `hot_topics_weekly_cap` | 0–14 brouillons non rejetés sur 7 jours glissants | `2` |
| `hot_topics_recent` | (auto) sujets des 7 derniers jours + type, anti-doublon | |
| `hot_topics_last_run` | (auto) dernier résultat : plan, sujets rejetés et pourquoi | |

Le brouillon expire seul après 2 jours (`draft-ttl`).

**Coupe-circuit** : `hot_topics_mode = off` arrête les nouveaux brouillons. Un brouillon déjà approuvé se
retire de la file depuis `/drafts`.

## Mise en route recommandée (test de 4 semaines)

1. Prévisualiser sans rien écrire :
   `node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/hot-topics-preview.mts <dossier>`
   (vraies sources + vrai modèle, écrit les cartes PNG ; seule écriture : le compteur de tokens LLM).
2. `hot_topics_mode = dry`, appeler `GET /api/cron/hot-topics?dry=1` (Bearer CRON_SECRET), lire
   `hot_topics_last_run`.
3. Quand la qualité convient : `live`. Mesurer 4 semaines (≈ 8 posts) : commentaires, partages, clics UTM,
   comparés à des posts produit ; décider ensuite de continuer, d'ajuster ou d'arrêter.

## Pas fait (idées pour la suite)

- Alertes météo d'Environnement Canada comme source (première bordée, froid extrême).
- Autres flux (TVA Nouvelles, Radio-Canada culture) — à tester avant d'ajouter.
- Mot-filtre Facebook côté page pour la modération des commentaires (réglage Facebook, pas du code).
- Posts « A ou B » avec de vrais produits (test séparé).
