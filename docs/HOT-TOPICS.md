# Posts « sujet chaud » (Facebook)

Un post de jasette, 2 fois par semaine, qui rebondit sur ce dont le Québec parle (le Canadien, la première
bordée, Noël en novembre…) pour faire commenter la page. **Rien ne se publie sans approbation humaine.**

## Flux

```
/api/cron/hot-topics (mar + jeu 11:00 UTC)
  sources RSS gratuites ──► liste noire (avant le LLM) ──► LLM « strong » (choisit + écrit)
        │                                                        │
 Google Trends QC                                       validation dure (catégorie, question,
 La Presse Sports                                       pas d'appât, pas de nom de fournisseur,
 Journal de Montréal Sports                             liste noire à nouveau sur carte + légende)
                                                                 │
                              carte PNG rouge (sharp) ► Blob public ► facebook_drafts (hot_topic, 'draft')
                                                                 │
                                       /drafts → filtre « Sujets chauds » → approuver (1 clic)
                                                                 │
                                       publication_queue → /api/cron/publisher
```

Google Actualités RSS n'est volontairement pas utilisé (conditions : lecteur personnel seulement).
On ne reprend que des **manchettes comme inspiration** pour une question originale — aucun contenu d'article.

## Réglages (table `settings`)

| Clé | Valeurs | Défaut |
|---|---|---|
| `hot_topics_mode` | `off` · `dry` (génère, ne stocke rien) · `live` (crée 1 brouillon par passage) | `off` |
| `hot_topics_weekly_cap` | 0–14 brouillons non rejetés sur 7 jours glissants | `2` |
| `hot_topics_recent` | (auto) sujets des 7 derniers jours, anti-doublon | |
| `hot_topics_last_run` | (auto) dernier résultat : plan, sujets rejetés et pourquoi | |

Le brouillon expire seul après 2 jours (`draft-ttl`) : un sujet chaud périme vite.

## Mise en route recommandée

1. Prévisualiser sans rien écrire :
   `node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/hot-topics-preview.mts <dossier>`
   (vrais flux + vrai modèle, écrit les cartes PNG ; seule écriture : le compteur de tokens LLM).
2. Mettre `hot_topics_mode = dry`, appeler `GET /api/cron/hot-topics?dry=1` (Bearer CRON_SECRET), lire
   `hot_topics_last_run` pendant quelques jours.
3. Quand la qualité convient : `hot_topics_mode = live`. Les brouillons arrivent dans `/drafts`
   (filtre « Sujets chauds »).

## Garde-fous

- **Liste noire** (`src/lib/hot-topics/safety.ts`) : politique, religion, guerre/immigration, tragédies,
  santé, justice, rappels. Appliquée sur les manchettes AVANT le modèle, puis sur la carte et la légende APRÈS.
  Volontairement stricte : perdre un candidat coûte peu, un faux négatif est un incident de marque.
- Catégories permises : sport, météo, culture, fêtes, quotidien.
- Pas de « commente / partage / tague » (Facebook pénalise l'appât à engagement) ; une vraie question suffit.
- Aucune mention de meubles, de prix ni de fournisseur dans ces posts.
- FR seulement (pas de version EN : le canal Furnish saute ce brouillon, faute de `post_text_en`).
