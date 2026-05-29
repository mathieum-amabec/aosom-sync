/**
 * Megastore content templates — 12 templates aligned with the validated
 * non-product content vision (2026-05-08).
 *
 * Categories: education (3), inspiration (4), engagement (3), seasonal (2)
 * Variables in prompt_pattern_fr:
 *   {{hook}}     — auto-injected from 200-hook pool
 *   {{category}} — passed as category_filter param (templates #2, #3, #10)
 *   {{season}}   — computed server-side from current date (#5, #11, #12)
 *   {{month}}    — computed server-side from current date (#11, #12)
 */

export interface ContentTemplateSeed {
  slug: string;
  content_type: "education" | "inspiration" | "engagement" | "seasonal";
  mode: "hook_seeded" | "generative_seeded";
  display_name_fr: string;
  display_name_en: string;
  prompt_pattern_fr: string;
  prompt_pattern_en: string;
  image_strategy: string;
  active: boolean;
  frequency_per_month: number;
  scopes: string[];
}

/**
 * Clickbait templates (2026-05-28) — punchy scroll-stopping openers and an
 * open question close. Fully bilingual (no TODO_EN). Inserted idempotently in
 * initSchema via INSERT OR IGNORE so already-seeded production DBs pick them up.
 */
export const CLICKBAIT_TEMPLATES: ContentTemplateSeed[] = [
  {
    slug: "clickbait_erreur_meubles",
    content_type: "education",
    mode: "generative_seeded",
    display_name_fr: "Clickbait — L'erreur #1 meubles",
    display_name_en: "Clickbait — #1 furniture mistake",
    scopes: ["mobilier_indoor"],
    frequency_per_month: 2,
    image_strategy: "lifestyle",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise de meubles et décoration. Ton audience: 25-45 ans au Québec.

Ouvre par une accroche choc que tu génères toi-même — une question percutante OU une affirmation surprenante qui arrête le défilement. Inspire-toi du ton: "L'erreur #1 que tout le monde fait en achetant un meuble..." Ne révèle pas tout dans l'accroche.

Génère un post Facebook qui expose UNE erreur fréquente quand les gens achètent ou placent un meuble, puis donne la solution concrète.

Contraintes:
- Tutoiement OBLIGATOIRE (tu/te/ton) dans tout le post — corps ET CTA. Jamais de vous/votre/vos.
- Une seule erreur, une seule solution claire et actionnable
- Mentionne naturellement qu'Ameublo Direct aide à bien choisir (sans vente forcée)
- Termine par une question ouverte qui invite les commentaires: "Tu as déjà fait cette erreur? Raconte 👇"
- 90-120 mots, français québécois, 2-3 emojis, aucun prix, aucun lien

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: `You are the content lead for Ameublo Direct, a Quebec furniture and home decor store. Audience: 25-45 year olds.

Open with a scroll-stopping hook you generate yourself — a punchy question OR a surprising statement. Tone reference: "Everyone makes this #1 mistake when buying furniture..." Do not reveal everything in the hook.

Write a Facebook post that exposes ONE common mistake people make when buying or placing furniture, then give the concrete fix.

Constraints:
- One mistake, one clear actionable fix
- Naturally mention Ameublo Direct helps you choose right (no hard sell)
- End with an open question inviting comments: "Have you made this mistake? Tell us 👇"
- 90-120 words, 2-3 emojis, no prices, no links

Return only the post, ready to publish.`,
  },
  {
    slug: "clickbait_canape_personnalite",
    content_type: "engagement",
    mode: "generative_seeded",
    display_name_fr: "Clickbait — Ton canapé révèle ta personnalité",
    display_name_en: "Clickbait — Your sofa personality",
    scopes: ["mobilier_indoor"],
    frequency_per_month: 2,
    image_strategy: "lifestyle",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise de meubles et décoration. Ton audience: 25-45 ans au Québec.

Ouvre par une accroche choc que tu génères toi-même — une question surprenante du genre: "Ton canapé en dit plus long sur toi que tu penses." Intrigante, légère.

Génère un post Facebook ludique qui associe 3-4 styles de canapé à un trait de personnalité. Pas un test sérieux — c'est pour s'amuser et faire réagir.

Contraintes:
- Tutoiement OBLIGATOIRE (tu/te/ton) dans tout le post — corps ET CTA. Jamais de vous/votre/vos.
- 3-4 associations style → personnalité, courtes et drôles
- Mentionne qu'Ameublo Direct a tous ces styles (ton naturel)
- Termine par une question ouverte: "C'est quoi ton canapé — et est-ce que ça te ressemble? 👇"
- 80-110 mots, français québécois, 2-3 emojis

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: `You are the content lead for Ameublo Direct, a Quebec furniture and home decor store. Audience: 25-45 year olds.

Open with a scroll-stopping hook you generate yourself — a surprising question like: "Your sofa says more about you than you think." Intriguing, playful.

Write a fun Facebook post that pairs 3-4 sofa styles with a personality trait. Not a serious test — it is for fun and reactions.

Constraints:
- 3-4 style → personality pairings, short and funny
- Mention Ameublo Direct carries all these styles (natural tone)
- End with an open question: "What is your sofa — and does it match you? 👇"
- 80-110 words, 2-3 emojis

Return only the post, ready to publish.`,
  },
  {
    slug: "clickbait_regle_design_pros",
    content_type: "education",
    mode: "generative_seeded",
    display_name_fr: "Clickbait — La règle des designers pros",
    display_name_en: "Clickbait — The pro designer rule",
    scopes: ["mobilier_indoor", "bedroom_decor"],
    frequency_per_month: 2,
    image_strategy: "text_overlay",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise de meubles et décoration. Ton audience: 25-45 ans au Québec.

Ouvre par une accroche choc que tu génères toi-même — une affirmation surprenante du genre: "La règle que les designers pros utilisent et que presque personne ne connaît..." Crée de la curiosité.

Génère un post Facebook qui révèle UNE règle de design d'intérieur que les pros appliquent (ex: la règle 60-30-10 des couleurs, la hauteur des cadres à hauteur des yeux, le bon format de tapis). Explique-la simplement.

Contraintes:
- Tutoiement OBLIGATOIRE (tu/te/ton) dans tout le post — corps ET CTA. Jamais de vous/votre/vos.
- Une seule règle, expliquée en termes simples avec un exemple concret
- Mentionne naturellement qu'Ameublo Direct a ce qu'il faut pour l'appliquer
- Termine par une question ouverte: "Tu connaissais cette règle? 👇"
- 90-120 mots, français québécois, 2-3 emojis

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: `You are the content lead for Ameublo Direct, a Quebec furniture and home decor store. Audience: 25-45 year olds.

Open with a scroll-stopping hook you generate yourself — a surprising statement like: "The rule pro designers use that almost no one knows..." Build curiosity.

Write a Facebook post that reveals ONE interior design rule the pros apply (e.g., the 60-30-10 color rule, hanging art at eye level, the right rug size). Explain it simply.

Constraints:
- One rule, explained in plain terms with a concrete example
- Naturally mention Ameublo Direct has what you need to apply it
- End with an open question: "Did you know this rule? 👇"
- 90-120 words, 2-3 emojis

Return only the post, ready to publish.`,
  },
  {
    slug: "clickbait_salon_desordre",
    content_type: "education",
    mode: "generative_seeded",
    display_name_fr: "Clickbait — Pourquoi ton salon paraît petit",
    display_name_en: "Clickbait — Why your room looks small",
    scopes: ["mobilier_indoor", "storage_kitchen"],
    frequency_per_month: 2,
    image_strategy: "lifestyle",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise de meubles et décoration. Ton audience: 25-45 ans au Québec.

Ouvre par cette accroche choc (ou une variante très proche): "Pourquoi ton salon paraît petit? (indice: c'est pas la grandeur)". Intrigue immédiate.

Génère un post Facebook qui explique pourquoi une pièce paraît plus petite qu'elle ne l'est (désordre visuel, mauvais agencement, meubles trop massifs, manque de rangement) et donne 1-2 solutions concrètes.

Contraintes:
- Tutoiement OBLIGATOIRE (tu/te/ton) dans tout le post — corps ET CTA. Jamais de vous/votre/vos.
- Cause + solution concrète, pas de généralités
- Mentionne naturellement que le bon rangement/mobilier d'Ameublo Direct aide
- Termine par une question ouverte: "C'est quoi le coin le plus encombré chez toi? 👇"
- 90-120 mots, français québécois, 2-3 emojis

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: `You are the content lead for Ameublo Direct, a Quebec furniture and home decor store. Audience: 25-45 year olds.

Open with this scroll-stopping hook (or a very close variant): "Hot take: your room looks small because of clutter, not size." Instant intrigue.

Write a Facebook post that explains why a room looks smaller than it is (visual clutter, poor layout, oversized furniture, lack of storage) and give 1-2 concrete fixes.

Constraints:
- Cause + concrete fix, no generalities
- Naturally mention the right storage/furniture from Ameublo Direct helps
- End with an open question: "What is the most cluttered corner in your home? 👇"
- 90-120 words, 2-3 emojis

Return only the post, ready to publish.`,
  },
  {
    slug: "clickbait_meuble_essentiel",
    content_type: "inspiration",
    mode: "generative_seeded",
    display_name_fr: "Clickbait — Le meuble que tout le monde devrait avoir",
    display_name_en: "Clickbait — The one piece everyone needs",
    scopes: ["mobilier_indoor", "storage_kitchen"],
    frequency_per_month: 2,
    image_strategy: "random_product",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise de meubles et décoration. Ton audience: 25-45 ans au Québec.

Ouvre par une accroche choc que tu génères toi-même — du genre: "Le meuble que tout le monde devrait avoir (et que 90% oublient)..." Crée de l'attente.

Génère un post Facebook qui défend UN meuble polyvalent sous-estimé (ex: pouf de rangement, console d'entrée, banc multifonction) et explique pourquoi il change la vie au quotidien.

Contraintes:
- Tutoiement OBLIGATOIRE (tu/te/ton) dans tout le post — corps ET CTA. Jamais de vous/votre/vos.
- 2-3 usages concrets qui justifient l'achat
- Mentionne qu'Ameublo Direct en propose (ton naturel)
- Termine par une question ouverte: "Tu en as un chez toi? Sinon, ça te tente? 👇"
- 90-120 mots, français québécois, 2-3 emojis

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: `You are the content lead for Ameublo Direct, a Quebec furniture and home decor store. Audience: 25-45 year olds.

Open with a scroll-stopping hook you generate yourself — something like: "The one piece of furniture everyone needs (and most forget)..." Build anticipation.

Write a Facebook post that champions ONE underrated versatile piece (e.g., storage ottoman, entryway console, multifunction bench) and explain why it changes daily life.

Constraints:
- 2-3 concrete uses that justify buying it
- Mention Ameublo Direct carries it (natural tone)
- End with an open question: "Do you own one? If not, are you tempted? 👇"
- 90-120 words, 2-3 emojis

Return only the post, ready to publish.`,
  },
  {
    slug: "clickbait_hot_take",
    content_type: "engagement",
    mode: "generative_seeded",
    display_name_fr: "Clickbait — Hot take déco",
    display_name_en: "Clickbait — Furniture hot take",
    scopes: ["universal"],
    frequency_per_month: 2,
    image_strategy: "none",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise de meubles et décoration. Ton audience: 25-45 ans au Québec.

Ouvre par une accroche choc que tu génères toi-même — une opinion tranchée et débattable du genre: "Hot take déco: un gros canapé rend ton salon plus petit." Assume l'opinion.

Génère un post Facebook qui défend une opinion déco/aménagement clivante (mais défendable), avec 1-2 arguments. Le but est de faire débattre dans les commentaires.

Contraintes:
- Tutoiement OBLIGATOIRE (tu/te/ton) dans tout le post — corps ET CTA. Jamais de vous/votre/vos.
- Opinion claire + 1-2 arguments courts
- PAS de vente forcée — l'engagement seul suffit
- Termine par une question ouverte: "T'es d'accord ou pas du tout? Dis-le 👇"
- 60-90 mots, français québécois, 2-3 emojis

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: `You are the content lead for Ameublo Direct, a Quebec furniture and home decor store. Audience: 25-45 year olds.

Open with a scroll-stopping hook you generate yourself — a bold debatable opinion like: "Hot take: bigger furniture = smaller room." Own the opinion.

Write a Facebook post that defends one divisive (but defensible) decor/layout opinion, with 1-2 arguments. The goal is to spark debate in the comments.

Constraints:
- Clear opinion + 1-2 short arguments
- No hard sell — engagement alone is the goal
- End with an open question: "Agree or totally disagree? Tell us 👇"
- 60-90 words, 2-3 emojis

Return only the post, ready to publish.`,
  },
];

export const MEGASTORE_TEMPLATES: ContentTemplateSeed[] = [
  // ─── EDUCATION (3) ──────────────────────────────────────────────────────────
  {
    slug: "conseil_deco_piece",
    content_type: "education",
    mode: "generative_seeded",
    display_name_fr: "Conseil déco par pièce",
    display_name_en: "Room decor tips",
    scopes: ["mobilier_indoor", "bedroom_decor"],
    frequency_per_month: 2,
    image_strategy: "lifestyle",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise de meubles et décoration. Ton audience: propriétaires et locataires de 25-45 ans au Québec qui veulent un bel intérieur sans se ruiner.

Commence par une accroche percutante que tu génères toi-même — 8-15 mots, évoque un secret de déco, une erreur courante ou une révélation sur l'aménagement intérieur.

Génère un post Facebook qui donne 1 conseil concret d'aménagement ou de décoration pour une pièce intérieure (salon, chambre, bureau à domicile ou salle à manger — choisis la plus pertinente selon la saison). Le conseil doit être actionnable aujourd'hui.

Contraintes:
- Ton chaleureux et accessible, comme un ami qui s'y connaît
- Mentionne naturellement qu'Ameublo Direct a ce qu'il faut (sans vente forcée)
- Termine par une question d'engagement: "Et toi, [question sur la pièce]?"
- 90-120 mots, français québécois naturel
- 2-3 emojis pertinents
- Aucun prix, aucun lien

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: "TODO_EN",
  },
  {
    slug: "guide_achat_categorie",
    content_type: "education",
    mode: "generative_seeded",
    display_name_fr: "Guide d'achat par catégorie",
    display_name_en: "Category buying guide",
    scopes: ["universal"],
    frequency_per_month: 2,
    image_strategy: "text_overlay",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise spécialisée en meubles, mobilier de jardin, accessoires pour animaux et articles pour la famille. Ton audience: 25-45 ans au Québec, qui magasine en ligne et veut faire de bons achats.

Commence par une accroche percutante que tu génères toi-même — 8-15 mots, évoque ce que les gens oublient souvent avant d'acheter en {{category}}. Ton de conseil bienveillant.

Génère un guide d'achat rapide (3 critères clés) pour la catégorie suivante: {{category}}.

Contraintes:
- 3 critères concrets à vérifier avant d'acheter (matière, dimensions, usage, durabilité ou entretien — selon ce qui est le plus pertinent pour {{category}})
- Ton pédagogique mais accessible, zéro jargon technique
- Mentionne naturellement qu'Ameublo Direct propose une sélection de {{category}} déjà filtrée selon ces critères
- Termine par: "Des questions? On est là pour t'aider à choisir. 👇"
- 100-130 mots, français québécois
- 2-3 emojis

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: "TODO_EN",
  },
  {
    slug: "astuces_entretien",
    content_type: "education",
    mode: "generative_seeded",
    display_name_fr: "Astuces entretien & maintenance",
    display_name_en: "Maintenance tips",
    scopes: ["universal"],
    frequency_per_month: 2,
    image_strategy: "text_overlay",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise de meubles et articles pour la maison. Ton audience: québécois de 25-45 ans qui veulent que leurs achats durent longtemps.

Commence par une accroche percutante que tu génères toi-même — 8-15 mots, évoque un secret de pro ou une erreur d'entretien à éviter. Pratique et utile.

Génère un post Facebook avec 1-2 astuces concrètes d'entretien ou de maintenance pour la catégorie de produits suivante: {{category}}.

Contraintes:
- Astuce(s) directement applicables, pas de généralités
- Ton: "ami bricoleur" — simple, utile, sans condescendance
- Lien subtil: bon entretien = produit qui dure = meilleur rapport qualité-prix (relie naturellement à Ameublo Direct sans vendre)
- Termine par: "Tu as d'autres trucs d'entretien à partager? 🔧"
- 80-110 mots, français québécois
- 2 emojis max

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: "TODO_EN",
  },

  // ─── INSPIRATION (4) ────────────────────────────────────────────────────────
  {
    slug: "inspiration_ambiance_maison",
    content_type: "inspiration",
    mode: "generative_seeded",
    display_name_fr: "Inspiration ambiance maison",
    display_name_en: "Home ambiance inspiration",
    scopes: ["mobilier_indoor", "bedroom_decor"],
    frequency_per_month: 2,
    image_strategy: "lifestyle",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise de meubles et déco intérieure. Ton audience: 25-45 ans au Québec qui rêvent d'un intérieur qui leur ressemble.

Commence par une accroche évocatrice que tu génères toi-même — 8-15 mots, crée une image mentale ou sensorielle d'un intérieur réussi. Poétique, désirable.

Génère un post Facebook inspirationnel sur une ambiance intérieure tendance (cozy scandinave, moderne épuré, bohème naturel, industriel chaleureux — choisis selon la saison actuelle). Pas un guide pratique — une image mentale qui donne envie.

Contraintes:
- Tutoiement OBLIGATOIRE (tu/te/ton) dans tout le post — corps ET CTA. Jamais de vous/votre/vos.
- Évoque des sensations, des matières, des couleurs — PAS une liste de produits
- 1 phrase qui relie subtilement l'ambiance à ce qu'on trouve chez Ameublo Direct
- Termine par: "C'est quoi ton style de déco idéal? 🏠"
- 80-110 mots, français québécois évocateur
- 2-3 emojis

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: "TODO_EN",
  },
  {
    slug: "inspiration_vie_outdoor",
    content_type: "inspiration",
    mode: "generative_seeded",
    display_name_fr: "Inspiration vie outdoor",
    display_name_en: "Outdoor life inspiration",
    scopes: ["outdoor_patio"],
    frequency_per_month: 2,
    image_strategy: "lifestyle",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise qui vend du mobilier de terrasse et de jardin. Ton audience: 25-45 ans avec une terrasse, un balcon ou une cour.

Saison actuelle: {{season}}

Commence par une accroche évocatrice que tu génères toi-même — 8-15 mots, évoque un moment de vie idéal à l'extérieur en {{season}} au Québec. Vivant et sensoriel.

Génère un post Facebook inspirationnel sur la vie extérieure québécoise (terrasse, soirées d'été, déjeuners au jardin, automne dehors — selon {{season}}).

Contraintes:
- Tutoiement OBLIGATOIRE (tu/te/ton) dans tout le post — corps ET CTA. Jamais de vous/votre/vos.
- Évoque un moment de vie concret et désirable (visuel, sensoriel)
- 1 phrase naturelle sur ce qu'Ameublo Direct offre pour créer cet espace
- Termine par: "C'est quoi ton moment préféré sur ta terrasse? ☀️"
- 80-110 mots, ton énergique (été) ou nostalgique (automne) selon {{season}}
- 2-3 emojis

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: "TODO_EN",
  },
  {
    slug: "inspiration_animaux",
    content_type: "inspiration",
    mode: "generative_seeded",
    display_name_fr: "Inspiration vie avec animaux",
    display_name_en: "Pet life inspiration",
    scopes: ["pets"],
    frequency_per_month: 1,
    image_strategy: "lifestyle",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise qui vend des accessoires et mobilier pour animaux de compagnie. Ton audience: propriétaires d'animaux québécois de 25-45 ans qui traitent leur animal comme un membre de la famille.

Commence par une accroche évocatrice que tu génères toi-même — 8-15 mots, évoque un moment tendre et reconnaissable avec un animal de compagnie.

Génère un post Facebook inspirationnel et chaleureux sur la vie avec un animal de compagnie à la maison (chien ou chat — choisis le plus cohérent avec l'accroche que tu as générée).

Contraintes:
- Tutoiement OBLIGATOIRE (tu/te/ton) dans tout le post — corps ET CTA. Jamais de vous/votre/vos.
- Moment de vie tendre et reconnaissable par tout propriétaire d'animal
- 1 phrase sur le fait qu'Ameublo Direct a des accessoires pour animaux (ton naturel, pas publicitaire)
- Termine par: "Tu as un animal? Montre-nous une photo dans les commentaires! 🐾"
- 70-100 mots, humour doux bienvenu
- 2-3 emojis

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: "TODO_EN",
  },
  {
    slug: "inspiration_famille",
    content_type: "inspiration",
    mode: "generative_seeded",
    display_name_fr: "Inspiration vie de famille",
    display_name_en: "Family life inspiration",
    scopes: ["kids_toys_sport", "mobilier_indoor"],
    frequency_per_month: 1,
    image_strategy: "lifestyle",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise de meubles, jouets et articles pour la famille. Ton audience: parents québécois de 28-45 ans avec enfants à la maison.

Commence par une accroche évocatrice que tu génères toi-même — 8-15 mots, évoque une scène familière et complice de la vie de famille à la maison. Ton parent-à-parent, complice.

Génère un post Facebook inspirationnel sur la vie de famille à la maison — un moment quotidien touchant ou légèrement drôle avec les enfants (jeux, soirées, chaos organisé, moments calmes).

Contraintes:
- Tutoiement OBLIGATOIRE (tu/te/ton) dans tout le post — corps ET CTA. Jamais de vous/votre/vos.
- Ton: parent qui parle à d'autres parents — complice, humour doux, pas condescendant
- 1 phrase naturelle sur ce qu'Ameublo Direct offre pour les familles
- Termine par: "C'est quoi ton activité préférée en famille à la maison? 👨‍👩‍👧‍👦"
- 80-110 mots, français québécois familier
- 2-3 emojis

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: "TODO_EN",
  },

  // ─── ENGAGEMENT (3) ─────────────────────────────────────────────────────────
  {
    slug: "sondage_debat",
    content_type: "engagement",
    mode: "hook_seeded",
    display_name_fr: "Sondage / Question débat",
    display_name_en: "Poll / Debate question",
    scopes: ["universal"],
    frequency_per_month: 3,
    image_strategy: "none",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise de meubles et articles pour la maison. Ton audience: 25-45 ans au Québec.

Commence exactement par cette accroche: {{hook}}

Génère un sondage ou une question-débat sur la déco, les habitudes de vie à la maison ou les préférences des québécois chez eux. Sujet universel qui génère des opinions (pas de bonne ou mauvaise réponse).

Contraintes:
- 2 options claires et opposées (Équipe A vs Équipe B)
- Ton ludique et léger — on s'amuse
- PAS de mention de produits ou d'Ameublo Direct (l'engagement seul suffit)
- Termine par: "Dis-nous dans les commentaires! 👇"
- 50-75 mots, très court et direct
- 2-3 emojis

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: "TODO_EN",
  },
  {
    slug: "devine_quizz",
    content_type: "engagement",
    mode: "hook_seeded",
    display_name_fr: "Devine quoi / Quizz",
    display_name_en: "Guess what / Quiz",
    scopes: ["universal"],
    frequency_per_month: 1,
    image_strategy: "random_product",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise de meubles et articles pour la maison. Ton audience: 25-45 ans au Québec.

Commence exactement par cette accroche: {{hook}}

Génère un post-quizz "devine le prix" basé sur un article de mobilier ou de déco vendu chez Ameublo Direct. Rends-le légèrement surprenant (prix plus bas que prévu).

Contraintes:
- Décris l'article sans le nommer directement (matière, dimensions, usage)
- 3 choix de prix plausibles dont un seul est vrai
- Révèle la réponse dans le même post avec un moment "wow — vraiment?"
- Mentionne Ameublo Direct naturellement dans la révélation
- 60-90 mots, ton ludique
- 2-3 emojis

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: "TODO_EN",
  },
  {
    slug: "aide_choisir",
    content_type: "engagement",
    mode: "hook_seeded",
    display_name_fr: "Aide à choisir",
    display_name_en: "Help me choose",
    scopes: ["universal"],
    frequency_per_month: 2,
    image_strategy: "random_product",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise de meubles et articles pour la maison. Ton audience: 25-45 ans au Québec qui magasinent en ligne.

Commence exactement par cette accroche: {{hook}}

Génère un post "aide-nous à choisir" avec 2 variantes d'un même type de produit — un vrai dilemme d'achat que tout le monde reconnaît.

Contraintes:
- 2 options concrètes avec leurs avantages respectifs (matière, style, usage)
- Catégorie de produit: {{category}}
- Ton: on demande leur expertise — les abonnés sont les vrais experts
- Les deux options sont disponibles chez Ameublo Direct (mentionner dans l'intro)
- Termine par: "Équipe A ou équipe B? 👇"
- 60-90 mots, français québécois
- 2 emojis

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: "TODO_EN",
  },

  // ─── SEASONAL (2) ───────────────────────────────────────────────────────────
  {
    slug: "saisonnier_outdoor",
    content_type: "seasonal",
    mode: "generative_seeded",
    display_name_fr: "Saisonnier outdoor",
    display_name_en: "Seasonal outdoor",
    scopes: ["outdoor_patio", "kids_toys_sport"],
    frequency_per_month: 2,
    image_strategy: "lifestyle",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise qui vend du mobilier d'extérieur et articles de sport et jeux pour les familles. Ton audience: 25-45 ans au Québec avec terrasse, cour ou chalet.

Saison actuelle: {{season}} ({{month}})

Commence par une accroche percutante que tu génères toi-même — 8-15 mots, évoque l'anticipation ou l'émotion propre à {{season}} pour les Québécois dehors. Ancré dans la réalité climatique québécoise.

Génère un post Facebook saisonnier sur la vie extérieure québécoise en {{season}}. Ancre-toi dans la réalité climatique québécoise (étés courts et intenses, automne coloré, préparation avant l'hiver, printemps tardif attendu depuis des mois).

Contraintes:
- Tutoiement OBLIGATOIRE (tu/te/ton) dans tout le post — corps ET CTA. Jamais de vous/votre/vos.
- Évoque l'émotion propre à cette saison extérieure au Québec
- 1 call-to-action naturel vers les produits saisonniers d'Ameublo Direct
- Termine par une question liée à la saison
- 80-120 mots, ton énergique (printemps/été) ou nostalgique (automne)
- 2-3 emojis

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: "TODO_EN",
  },
  {
    slug: "saisonnier_indoor",
    content_type: "seasonal",
    mode: "generative_seeded",
    display_name_fr: "Saisonnier indoor",
    display_name_en: "Seasonal indoor",
    scopes: ["mobilier_indoor", "storage_kitchen", "bedroom_decor"],
    frequency_per_month: 2,
    image_strategy: "lifestyle",
    active: true,
    prompt_pattern_fr: `Tu es le responsable contenu d'Ameublo Direct, boutique québécoise de meubles et déco intérieure. Ton audience: 25-45 ans au Québec qui passent 5-6 mois par année à l'intérieur.

Saison actuelle: {{season}} ({{month}})

Commence par une accroche évocatrice que tu génères toi-même — 8-15 mots, évoque l'ambiance saisonnière intérieure au Québec en {{season}}. Cozy et reconnaissable.

Génère un post Facebook saisonnier sur l'intérieur de la maison en {{season}}. Ancre-toi dans la réalité québécoise (cocooning hivernal, grand ménage printanier, rentrée automnale, fraîcheur estivale à l'intérieur).

Contraintes:
- Tutoiement OBLIGATOIRE (tu/te/ton) dans tout le post — corps ET CTA. Jamais de vous/votre/vos.
- Relie la saison à une action concrète d'aménagement ou de déco intérieure
- Mentionne Ameublo Direct naturellement comme source pour ces changements saisonniers
- Termine par une question sur les habitudes saisonnières de l'audience
- 80-120 mots, ton cozy (hiver/automne) ou énergique (printemps/été)
- 2-3 emojis

Retourne uniquement le post, prêt à publier.`,
    prompt_pattern_en: "TODO_EN",
  },

  // ─── CLICKBAIT (6) ──────────────────────────────────────────────────────────
  ...CLICKBAIT_TEMPLATES,
];
