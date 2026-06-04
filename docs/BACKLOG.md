# Backlog

Tracked follow-up work. Priorities: P0 (urgent) → P4 (nice-to-have).

---

## BACKLOG — Blog bilingue synchronisé

**Priorité : P2**

**Contexte :** Le cron blog génère actuellement 1 article FR + 1 article EN
séparément avec des sujets rotatifs. Les deux blogs (`actualites` FR + `blog` EN)
ne sont pas synchronisés — un sujet FR peut différer du sujet EN.

**Objectif :** Chaque cycle de blog génère une paire d'articles sur le
MÊME sujet : 1 FR dans `/blogs/actualites` + 1 EN dans `/blogs/blog`.
Même topic, même structure, langues différentes.

**Impact :** Le thème affiche maintenant le bon blog selon la locale
(section homepage `lc_blog` bilingue : FR → `actualites`, EN → `blog`).
Si les articles sont sur le même sujet, un visiteur EN et FR voient
le même contenu dans leur langue — cohérence éditoriale totale.

**Scope technique :**
- Modifier le cron blog (job blog) pour générer les 2 articles
  en parallèle sur le même topic choisi
- S'assurer que les images Unsplash sont les mêmes pour FR + EN
- Vérifier que les handles/slugs sont distincts (FR vs EN)
