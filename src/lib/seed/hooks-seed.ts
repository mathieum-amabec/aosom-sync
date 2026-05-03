/**
 * Hook pool seed — 200 hooks (100 FR + 100 EN).
 *
 * Distribution per language (scope query counts, universal hooks match every scope):
 *   mobilier_indoor : 32  (14 pure + 10 mob+bed + 8 mob+outdoor)
 *   outdoor_patio   : 21  (13 pure + 8 mob+outdoor)
 *   pets            : 14
 *   kids_toys_sport : 14
 *   storage_kitchen : 17
 *   bedroom_decor   : 11  (1 pure + 10 mob+bed)
 *   universal       :  9
 *
 * 5 categories × 20 hooks × 2 languages = 200 total entries.
 * multi-tagged hooks (mob+bed, mob+outdoor) appear in multiple scope queries.
 */

export interface HookSeedEntry {
  categoryId: number;
  language: "FR" | "EN";
  text: string;
  productScopes: string[];
  mode: "pool" | "generative_seeded";
}

export interface HookCategoryEntry {
  id: number;
  name_fr: string;
  name_en: string;
  description: string;
}

export const HOOK_CATEGORIES: HookCategoryEntry[] = [
  { id: 1, name_fr: "Inspiration",  name_en: "Inspiration",  description: "Hooks that spark imagination and desire" },
  { id: 2, name_fr: "Pratique",     name_en: "Practical",    description: "Hooks that address a real need or problem" },
  { id: 3, name_fr: "Urgence",      name_en: "Urgency",      description: "Hooks that create FOMO or scarcity tension" },
  { id: 4, name_fr: "Engagement",   name_en: "Engagement",   description: "Hooks that invite participation or opinion" },
  { id: 5, name_fr: "Saisonnier",   name_en: "Seasonal",     description: "Hooks tied to seasons, weather or events" },
];

// ─── FR CATEGORY 1 — Inspiration (20 hooks) ──────────────────────────

const FR_CAT1: HookSeedEntry[] = [
  // universal (2)
  { categoryId: 1, language: "FR", text: "Certains espaces changent votre humeur dès que vous y entrez.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Le chez-soi qu'on mérite ne ressemble pas à celui de tout le monde.", productScopes: ["universal"], mode: "generative_seeded" },
  // mobilier_indoor pure (3)
  { categoryId: 1, language: "FR", text: "Un canapé bien choisi, c'est des années de bons souvenirs garantis.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Votre salon devrait vous ressembler autant que vos vêtements.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Choisir un meuble, c'est choisir comment vous voulez vivre dans cet espace.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // mobilier_indoor + bedroom_decor (2)
  { categoryId: 1, language: "FR", text: "Cette ambiance douce qu'on cherche dans les hôtels — elle peut exister chez vous.", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Le mobilier qu'on choisit une fois pour de bon mérite d'être parfait.", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "generative_seeded" },
  // outdoor_patio pure (3)
  { categoryId: 1, language: "FR", text: "Imaginez votre terrasse au soleil, un café en main, rien à faire.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Une belle cour arrière, c'est presque une deuxième maison.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Les meilleurs souvenirs d'été se passent en plein air.", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // mobilier_indoor + outdoor_patio (1)
  { categoryId: 1, language: "FR", text: "Cette texture, cette lumière, ces matières — à l'intérieur comme à l'extérieur.", productScopes: ["mobilier_indoor", "outdoor_patio"], mode: "pool" },
  // pets (3)
  { categoryId: 1, language: "FR", text: "Le coin favori de votre animal — parce qu'il le mérite autant que vous.", productScopes: ["pets"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Votre chien refuse de quitter son coin ? C'est un compliment.", productScopes: ["pets"], mode: "generative_seeded" },
  { categoryId: 1, language: "FR", text: "Un chat heureux, c'est un chat en hauteur. Les nôtres adorent ça.", productScopes: ["pets"], mode: "pool" },
  // kids_toys_sport (3)
  { categoryId: 1, language: "FR", text: "Ces matins où les enfants veulent jouer dehors dès le lever.", productScopes: ["kids_toys_sport"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Un enfant qui joue librement, c'est un enfant qui grandit bien.", productScopes: ["kids_toys_sport"], mode: "generative_seeded" },
  { categoryId: 1, language: "FR", text: "Offrir un espace de jeu, c'est offrir des heures de bonheur.", productScopes: ["kids_toys_sport"], mode: "pool" },
  // storage_kitchen (3)
  { categoryId: 1, language: "FR", text: "L'ordre, c'est le secret des maisons qui semblent toujours prêtes à accueillir.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Quand tout a sa place, la maison respire différemment.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Un rangement bien pensé, ça change toute l'expérience d'une pièce.", productScopes: ["storage_kitchen"], mode: "generative_seeded" },
];

// ─── FR CATEGORY 2 — Pratique (20 hooks) ─────────────────────────────

const FR_CAT2: HookSeedEntry[] = [
  // universal (1)
  { categoryId: 2, language: "FR", text: "Avant de commander : 3 questions à se poser pour ne pas regretter.", productScopes: ["universal"], mode: "pool" },
  // mobilier_indoor pure (3)
  { categoryId: 2, language: "FR", text: "Un meuble qui dure 15 ans coûte moins cher qu'un meuble qui dure 3.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Style + durabilité, sans vider votre compte en banque — c'est possible.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Chercher le bon meuble peut prendre des semaines. Ou 5 minutes ici.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // mobilier_indoor + bedroom_decor (2)
  { categoryId: 2, language: "FR", text: "Bien dormir commence avec l'environnement qu'on crée autour de soi.", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Investir dans sa chambre, c'est investir dans son énergie pour la journée.", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "generative_seeded" },
  // outdoor_patio pure (3)
  { categoryId: 2, language: "FR", text: "Comment choisir des meubles de patio qui tiennent plus d'une saison.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Résistant aux intempéries, facile à entretenir — voilà ce qu'on cherche.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Pour les hivers québécois : choisir des meubles extérieurs qui survivent.", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // mobilier_indoor + outdoor_patio (2)
  { categoryId: 2, language: "FR", text: "À l'intérieur ou dehors, la qualité se voit tout de suite.", productScopes: ["mobilier_indoor", "outdoor_patio"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Du salon au patio — la continuité dans le style, ça fait toute la différence.", productScopes: ["mobilier_indoor", "outdoor_patio"], mode: "generative_seeded" },
  // pets (3)
  { categoryId: 2, language: "FR", text: "Les erreurs courantes quand on choisit un panier pour son chien.", productScopes: ["pets"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Arbre à chat à 50$ vs 200$ : est-ce que ça vaut vraiment la différence ?", productScopes: ["pets"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Comment choisir la bonne taille d'enclos pour votre animal.", productScopes: ["pets"], mode: "generative_seeded" },
  // kids_toys_sport (3)
  { categoryId: 2, language: "FR", text: "Les 5 critères à vérifier avant d'acheter un trampoline pour les enfants.", productScopes: ["kids_toys_sport"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Voiture électrique enfant : ce qu'on ne vous dit pas dans les fiches produit.", productScopes: ["kids_toys_sport"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Cabane en bois ou en plastique ? Le vrai comparatif de parents.", productScopes: ["kids_toys_sport"], mode: "generative_seeded" },
  // storage_kitchen (3)
  { categoryId: 2, language: "FR", text: "Enfin une solution de rangement qui fonctionne vraiment.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Optimiser chaque mètre carré de cuisine — c'est possible avec le bon meuble.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Rangement visible, organisation invisible — le secret des maisons bien tenues.", productScopes: ["storage_kitchen"], mode: "generative_seeded" },
];

// ─── FR CATEGORY 3 — Urgence (20 hooks) ──────────────────────────────

const FR_CAT3: HookSeedEntry[] = [
  // universal (3)
  { categoryId: 3, language: "FR", text: "Dernières chances avant la rupture de stock — il en reste 4.", productScopes: ["universal"], mode: "generative_seeded" },
  { categoryId: 3, language: "FR", text: "Cette promo se termine vendredi. Pas de prolongation.", productScopes: ["universal"], mode: "generative_seeded" },
  { categoryId: 3, language: "FR", text: "7 unités encore en entrepôt. Après, on ne sait pas.", productScopes: ["universal"], mode: "generative_seeded" },
  // mobilier_indoor pure (3)
  { categoryId: 3, language: "FR", text: "Ce canapé est en promotion pour 48h seulement.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  { categoryId: 3, language: "FR", text: "Dernier lot de cette collection — le prochain arrivage n'est pas confirmé.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Prix promotionnel disponible pour quelques jours seulement.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // mobilier_indoor + bedroom_decor (2)
  { categoryId: 3, language: "FR", text: "Cette collection chambre part vite à chaque promotion — voilà pourquoi.", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Le set de chambre en spécial cette semaine seulement.", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "generative_seeded" },
  // outdoor_patio pure (3)
  { categoryId: 3, language: "FR", text: "La saison patio arrive vite — et les bons meubles partent encore plus vite.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Commander maintenant pour recevoir avant l'été.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Chaque printemps, les stocks s'épuisent avant la canicule.", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // mobilier_indoor + outdoor_patio (2)
  { categoryId: 3, language: "FR", text: "Patio ou salon — ces meubles partent à chaque promotion. Ne tardez pas.", productScopes: ["mobilier_indoor", "outdoor_patio"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Les meubles d'extérieur de qualité se vendent dès leur mise en ligne.", productScopes: ["mobilier_indoor", "outdoor_patio"], mode: "generative_seeded" },
  // pets (3)
  { categoryId: 3, language: "FR", text: "Dernier lot de cet arbre à chat best-seller — ne tardez pas.", productScopes: ["pets"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Panier orthopédique pour chien : stock limité, prix fixé jusqu'à dimanche.", productScopes: ["pets"], mode: "generative_seeded" },
  { categoryId: 3, language: "FR", text: "Ces niches d'extérieur sont presque épuisées. Il en reste quelques-unes.", productScopes: ["pets"], mode: "generative_seeded" },
  // kids_toys_sport (3)
  { categoryId: 3, language: "FR", text: "La voiture électrique la plus vendue — stock quasi épuisé pour l'été.", productScopes: ["kids_toys_sport"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Balançoire double en promotion cette semaine seulement.", productScopes: ["kids_toys_sport"], mode: "generative_seeded" },
  { categoryId: 3, language: "FR", text: "Trampoline à -25% jusqu'à vendredi. L'été commence bientôt.", productScopes: ["kids_toys_sport"], mode: "generative_seeded" },
  // storage_kitchen (1)
  { categoryId: 3, language: "FR", text: "Offre à durée limitée sur cette unité de rangement best-seller.", productScopes: ["storage_kitchen"], mode: "pool" },
];

// ─── FR CATEGORY 4 — Engagement (20 hooks) ───────────────────────────

const FR_CAT4: HookSeedEntry[] = [
  // universal (2)
  { categoryId: 4, language: "FR", text: "Coup de cœur ou trop osé ? On veut votre avis honnête.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Quel détail vous attire en premier sur cette photo ?", productScopes: ["universal"], mode: "pool" },
  // mobilier_indoor pure (3)
  { categoryId: 4, language: "FR", text: "Canapé droit ou canapé d'angle ? Le grand débat de salon.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Quelle couleur de meuble ne vieillira jamais selon vous ?", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Table basse ou ottoman ? Qu'est-ce qui trône dans votre salon ?", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // bedroom_decor pure (1)
  { categoryId: 4, language: "FR", text: "Lit plateforme ou lit traditionnel avec tête de lit ? Votre avis ?", productScopes: ["bedroom_decor"], mode: "pool" },
  // mobilier_indoor + bedroom_decor (2)
  { categoryId: 4, language: "FR", text: "Velours bleu marine ou cuir camel ? Quel tissu vous ressemble ?", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Si vous pouviez refaire une pièce demain, ce serait laquelle ?", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "generative_seeded" },
  // outdoor_patio pure (3)
  { categoryId: 4, language: "FR", text: "Terrasse ou cour arrière ? Montrez-nous votre espace extérieur préféré !", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Qu'est-ce que vous faites en premier sur votre patio le matin ?", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Vote : parasol ou pergola pour l'été québécois ?", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // mobilier_indoor + outdoor_patio (2)
  { categoryId: 4, language: "FR", text: "L'intérieur ou l'extérieur — dans quel espace vous sentez-vous le mieux ?", productScopes: ["mobilier_indoor", "outdoor_patio"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Votre style déco : même à l'intérieur qu'à l'extérieur, ou complètement différent ?", productScopes: ["mobilier_indoor", "outdoor_patio"], mode: "generative_seeded" },
  // pets (3)
  { categoryId: 4, language: "FR", text: "Votre chien monte sur le canapé ? On vous regarde sans vous juger.", productScopes: ["pets"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Team chat ou team chien ? Et qui occupe le plus d'espace chez vous ?", productScopes: ["pets"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Quel est l'endroit préféré de votre animal dans la maison ?", productScopes: ["pets"], mode: "generative_seeded" },
  // kids_toys_sport (3)
  { categoryId: 4, language: "FR", text: "Quel jouet auriez-vous voulu avoir quand vous étiez enfant ?", productScopes: ["kids_toys_sport"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Voiture électrique ou vélo pour votre enfant ? Le grand débat.", productScopes: ["kids_toys_sport"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Vos enfants préfèrent jouer seuls ou en groupe ?", productScopes: ["kids_toys_sport"], mode: "generative_seeded" },
  // storage_kitchen (1)
  { categoryId: 4, language: "FR", text: "Rangement minimaliste ou tout en ordre visible ? On débat.", productScopes: ["storage_kitchen"], mode: "pool" },
];

// ─── FR CATEGORY 5 — Saisonnier (20 hooks) ───────────────────────────

const FR_CAT5: HookSeedEntry[] = [
  // universal (1)
  { categoryId: 5, language: "FR", text: "On a calculé combien tu économises cette semaine. C'est important.", productScopes: ["universal"], mode: "pool" },
  // mobilier_indoor pure (2)
  { categoryId: 5, language: "FR", text: "Hiver québécois + bon canapé + plaid chaud = formule parfaite.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "Rénovation d'automne : commencez par le salon pour que ça compte.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // mobilier_indoor + bedroom_decor (2)
  { categoryId: 5, language: "FR", text: "Hiver = draps chauds, chambre cocooning. On s'équipe.", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "Printemps : rafraîchissez votre chambre avec quelques nouveautés.", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "generative_seeded" },
  // outdoor_patio pure (1)
  { categoryId: 5, language: "FR", text: "Le printemps arrive — est-ce que votre patio est prêt ?", productScopes: ["outdoor_patio"], mode: "pool" },
  // mobilier_indoor + outdoor_patio (1)
  { categoryId: 5, language: "FR", text: "L'été québécois est court. Profitez-en à fond, dehors comme dedans.", productScopes: ["mobilier_indoor", "outdoor_patio"], mode: "pool" },
  // pets (2)
  { categoryId: 5, language: "FR", text: "Vos animaux restent à l'intérieur en hiver — ont-ils leur coin confort ?", productScopes: ["pets"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "Premier printemps avec votre chiot ? On a ce qu'il lui faut.", productScopes: ["pets"], mode: "generative_seeded" },
  // kids_toys_sport (2)
  { categoryId: 5, language: "FR", text: "Vacances d'été : créez l'espace de jeu dont vos enfants rêvent.", productScopes: ["kids_toys_sport"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "La fin des camps approche — et si on leur installait quelque chose dans la cour ?", productScopes: ["kids_toys_sport"], mode: "generative_seeded" },
  // storage_kitchen (9)
  { categoryId: 5, language: "FR", text: "Grand ménage de printemps : commencez par le rangement. Ça libère tout.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "Rentrée scolaire = besoin urgent d'organisation à la maison.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "En hiver, on passe plus de temps chez soi — autant que ce soit bien rangé.", productScopes: ["storage_kitchen"], mode: "generative_seeded" },
  { categoryId: 5, language: "FR", text: "Déco de Noël rangée : c'est le bon moment pour revoir toute l'organisation.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "Printemps = le moment parfait pour désencombrer ce qui ne sert plus.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "La règle du 80/20 pour désencombrer et retrouver de l'espace.", productScopes: ["storage_kitchen"], mode: "generative_seeded" },
  { categoryId: 5, language: "FR", text: "Avant l'été, libérez votre espace de vie pour le savourer à fond.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "Rentrée : comment organiser l'espace de travail de vos enfants à la maison.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "Cuisiner est bien plus agréable dans une cuisine bien organisée.", productScopes: ["storage_kitchen"], mode: "generative_seeded" },
];

// ─── EN CATEGORY 1 — Inspiration (20 hooks) ──────────────────────────

const EN_CAT1: HookSeedEntry[] = [
  // universal (2)
  { categoryId: 1, language: "EN", text: "Some spaces change your mood the moment you walk in.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "The home you deserve doesn't look like everyone else's.", productScopes: ["universal"], mode: "generative_seeded" },
  // mobilier_indoor pure (3)
  { categoryId: 1, language: "EN", text: "A well-chosen sofa guarantees years of great memories.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "Your living room should reflect you as much as your wardrobe does.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "Choosing furniture is choosing how you want to live in that space.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // mobilier_indoor + bedroom_decor (2)
  { categoryId: 1, language: "EN", text: "That soft, cozy ambiance you find in hotels? It can exist in your home.", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "Furniture you choose once and keep forever deserves to be perfect.", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "generative_seeded" },
  // outdoor_patio pure (3)
  { categoryId: 1, language: "EN", text: "Picture your patio in the sun, coffee in hand, nothing to do.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "A beautiful backyard is almost a second home.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "The best summer memories are made outdoors.", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // mobilier_indoor + outdoor_patio (1)
  { categoryId: 1, language: "EN", text: "Texture, light, materials — indoors and outdoors alike.", productScopes: ["mobilier_indoor", "outdoor_patio"], mode: "pool" },
  // pets (3)
  { categoryId: 1, language: "EN", text: "Your pet's favourite spot — because they deserve it just as much as you do.", productScopes: ["pets"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "If your dog refuses to leave their corner, take it as a compliment.", productScopes: ["pets"], mode: "generative_seeded" },
  { categoryId: 1, language: "EN", text: "A happy cat is a cat up high. Ours love it.", productScopes: ["pets"], mode: "pool" },
  // kids_toys_sport (3)
  { categoryId: 1, language: "EN", text: "Those mornings when the kids want to play outside before breakfast.", productScopes: ["kids_toys_sport"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "A child who plays freely is a child who grows up well.", productScopes: ["kids_toys_sport"], mode: "generative_seeded" },
  { categoryId: 1, language: "EN", text: "Giving a play space is giving hours of happiness.", productScopes: ["kids_toys_sport"], mode: "pool" },
  // storage_kitchen (3)
  { categoryId: 1, language: "EN", text: "The secret of homes that always seem ready to welcome guests? Storage.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "When everything has a place, the whole home breathes differently.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "Well-planned storage changes the whole feel of a room.", productScopes: ["storage_kitchen"], mode: "generative_seeded" },
];

// ─── EN CATEGORY 2 — Practical (20 hooks) ────────────────────────────

const EN_CAT2: HookSeedEntry[] = [
  // universal (1)
  { categoryId: 2, language: "EN", text: "Before you order: 3 questions to ask yourself so you don't regret it.", productScopes: ["universal"], mode: "pool" },
  // mobilier_indoor pure (3)
  { categoryId: 2, language: "EN", text: "Furniture that lasts 15 years costs less than furniture that lasts 3.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Style and durability, without emptying your bank account — it's possible.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Finding the right furniture can take weeks. Or 5 minutes here.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // mobilier_indoor + bedroom_decor (2)
  { categoryId: 2, language: "EN", text: "Great sleep starts with the environment you create around yourself.", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Investing in your bedroom is investing in your energy for the day.", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "generative_seeded" },
  // outdoor_patio pure (3)
  { categoryId: 2, language: "EN", text: "How to choose patio furniture that lasts more than one season.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Weather-resistant, easy to maintain — that's what outdoor furniture should be.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "For Canadian winters: choosing outdoor furniture that actually survives them.", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // mobilier_indoor + outdoor_patio (2)
  { categoryId: 2, language: "EN", text: "Indoors or outdoors, quality is obvious right away.", productScopes: ["mobilier_indoor", "outdoor_patio"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "From living room to patio — continuity in style makes all the difference.", productScopes: ["mobilier_indoor", "outdoor_patio"], mode: "generative_seeded" },
  // pets (3)
  { categoryId: 2, language: "EN", text: "Common mistakes when choosing a bed for your dog.", productScopes: ["pets"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Cat tree at $50 vs $200: is the difference really worth it?", productScopes: ["pets"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "How to choose the right size enclosure for your pet.", productScopes: ["pets"], mode: "generative_seeded" },
  // kids_toys_sport (3)
  { categoryId: 2, language: "EN", text: "5 criteria to check before buying a trampoline for your kids.", productScopes: ["kids_toys_sport"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Kids electric cars: what they don't tell you in the product specs.", productScopes: ["kids_toys_sport"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Wooden or plastic playhouse? A real parents' comparison.", productScopes: ["kids_toys_sport"], mode: "generative_seeded" },
  // storage_kitchen (3)
  { categoryId: 2, language: "EN", text: "Finally, a storage solution that actually works.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Optimizing every square foot of your kitchen — doable with the right piece.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Visible storage, invisible mess — the secret of well-kept homes.", productScopes: ["storage_kitchen"], mode: "generative_seeded" },
];

// ─── EN CATEGORY 3 — Urgency (20 hooks) ──────────────────────────────

const EN_CAT3: HookSeedEntry[] = [
  // universal (3)
  { categoryId: 3, language: "EN", text: "Last chance before stock runs out — 4 left.", productScopes: ["universal"], mode: "generative_seeded" },
  { categoryId: 3, language: "EN", text: "This promotion ends Friday. No extension.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "7 units still in the warehouse. After that, we're not sure.", productScopes: ["universal"], mode: "pool" },
  // mobilier_indoor pure (3)
  { categoryId: 3, language: "EN", text: "This sofa is on sale for 48 hours only.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  { categoryId: 3, language: "EN", text: "Last batch of this collection — no confirmed restocking date.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "Promotional pricing available for a few days only.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // mobilier_indoor + bedroom_decor (2)
  { categoryId: 3, language: "EN", text: "This bedroom collection sells out fast every time it goes on sale.", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "The bedroom set on special this week only.", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "generative_seeded" },
  // outdoor_patio pure (3)
  { categoryId: 3, language: "EN", text: "Patio season arrives fast — and the good furniture goes even faster.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "Order now to receive before summer.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "Every spring, stock sells out before the heat wave hits.", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // mobilier_indoor + outdoor_patio (2)
  { categoryId: 3, language: "EN", text: "Patio or living room — these pieces sell out every promotion. Don't wait.", productScopes: ["mobilier_indoor", "outdoor_patio"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "Quality outdoor furniture sells out the moment it goes live.", productScopes: ["mobilier_indoor", "outdoor_patio"], mode: "generative_seeded" },
  // pets (3)
  { categoryId: 3, language: "EN", text: "Last batch of this best-selling cat tree — don't wait.", productScopes: ["pets"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "Orthopaedic dog bed: limited stock, price fixed until Sunday.", productScopes: ["pets"], mode: "generative_seeded" },
  { categoryId: 3, language: "EN", text: "These outdoor kennels are almost gone. A few left.", productScopes: ["pets"], mode: "generative_seeded" },
  // kids_toys_sport (3)
  { categoryId: 3, language: "EN", text: "The best-selling electric car — nearly sold out for summer.", productScopes: ["kids_toys_sport"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "Double swing on sale this week only.", productScopes: ["kids_toys_sport"], mode: "generative_seeded" },
  { categoryId: 3, language: "EN", text: "Trampoline at -25% until Friday. Summer is coming.", productScopes: ["kids_toys_sport"], mode: "generative_seeded" },
  // storage_kitchen (1)
  { categoryId: 3, language: "EN", text: "Limited-time offer on this best-selling storage unit.", productScopes: ["storage_kitchen"], mode: "pool" },
];

// ─── EN CATEGORY 4 — Engagement (20 hooks) ───────────────────────────

const EN_CAT4: HookSeedEntry[] = [
  // universal (2)
  { categoryId: 4, language: "EN", text: "Love at first sight or too bold? We want your honest opinion.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "What detail catches your eye first in this photo?", productScopes: ["universal"], mode: "pool" },
  // mobilier_indoor pure (3)
  { categoryId: 4, language: "EN", text: "Straight sofa or sectional? The great living room debate.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "What furniture colour will never go out of style in your opinion?", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "Coffee table or ottoman? What's the centrepiece of your living room?", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // bedroom_decor pure (1)
  { categoryId: 4, language: "EN", text: "Platform bed or traditional bed frame? What's your take?", productScopes: ["bedroom_decor"], mode: "pool" },
  // mobilier_indoor + bedroom_decor (2)
  { categoryId: 4, language: "EN", text: "Navy velvet or caramel leather? Which fabric feels most like you?", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "If you could redo one room tomorrow, which would it be?", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "generative_seeded" },
  // outdoor_patio pure (3)
  { categoryId: 4, language: "EN", text: "Deck or backyard? Show us your favourite outdoor space!", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "What's the first thing you do on your patio in the morning?", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "Vote: umbrella or pergola for the Canadian summer?", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // mobilier_indoor + outdoor_patio (2)
  { categoryId: 4, language: "EN", text: "Indoors or outdoors — where do you feel most like yourself?", productScopes: ["mobilier_indoor", "outdoor_patio"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "Your decor style: same inside and outside, or completely different?", productScopes: ["mobilier_indoor", "outdoor_patio"], mode: "generative_seeded" },
  // pets (3)
  { categoryId: 4, language: "EN", text: "Does your dog climb on the sofa? We see you — no judgement.", productScopes: ["pets"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "Team cat or team dog? And who takes up more space at home?", productScopes: ["pets"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "What's your pet's favourite spot in the house?", productScopes: ["pets"], mode: "generative_seeded" },
  // kids_toys_sport (3)
  { categoryId: 4, language: "EN", text: "What toy would you have dreamed of as a kid?", productScopes: ["kids_toys_sport"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "Electric car or bike for your child? The great debate.", productScopes: ["kids_toys_sport"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "Do your kids prefer to play alone or in a group?", productScopes: ["kids_toys_sport"], mode: "generative_seeded" },
  // storage_kitchen (1)
  { categoryId: 4, language: "EN", text: "Minimalist storage or everything neatly visible? Debate time.", productScopes: ["storage_kitchen"], mode: "pool" },
];

// ─── EN CATEGORY 5 — Seasonal (20 hooks) ─────────────────────────────

const EN_CAT5: HookSeedEntry[] = [
  // universal (1)
  { categoryId: 5, language: "EN", text: "We calculated how much you save this week. It matters.", productScopes: ["universal"], mode: "pool" },
  // mobilier_indoor pure (2)
  { categoryId: 5, language: "EN", text: "Canadian winter + good couch + warm blanket = perfect formula.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Fall refresh: start with the living room and everything follows.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // mobilier_indoor + bedroom_decor (2)
  { categoryId: 5, language: "EN", text: "Winter = warm sheets, cozy bedroom. Time to upgrade.", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Spring: refresh your bedroom with a few new pieces.", productScopes: ["mobilier_indoor", "bedroom_decor"], mode: "generative_seeded" },
  // outdoor_patio pure (1)
  { categoryId: 5, language: "EN", text: "Spring is coming — is your patio ready for it?", productScopes: ["outdoor_patio"], mode: "pool" },
  // mobilier_indoor + outdoor_patio (1)
  { categoryId: 5, language: "EN", text: "Canadian summers are short. Make the most of them, inside and out.", productScopes: ["mobilier_indoor", "outdoor_patio"], mode: "pool" },
  // pets (2)
  { categoryId: 5, language: "EN", text: "Your pets stay inside in winter — do they have a cozy corner?", productScopes: ["pets"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "First spring with your puppy? We have what they need.", productScopes: ["pets"], mode: "generative_seeded" },
  // kids_toys_sport (2)
  { categoryId: 5, language: "EN", text: "Summer vacation: build the play space your kids have been dreaming of.", productScopes: ["kids_toys_sport"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "End of camp is coming — how about setting something up in the backyard?", productScopes: ["kids_toys_sport"], mode: "generative_seeded" },
  // storage_kitchen (9)
  { categoryId: 5, language: "EN", text: "Spring cleaning: start with storage. It frees up everything else.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Back to school = urgent need for organization at home.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Winters mean more time indoors — might as well keep it well organized.", productScopes: ["storage_kitchen"], mode: "generative_seeded" },
  { categoryId: 5, language: "EN", text: "Holiday decorations packed away: perfect time to rethink your whole organization.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Spring = the perfect moment to clear out what you no longer use.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "The 80/20 rule for decluttering and reclaiming your space.", productScopes: ["storage_kitchen"], mode: "generative_seeded" },
  { categoryId: 5, language: "EN", text: "Before summer, free up your living space so you can actually enjoy it.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Back to school: how to set up a home workspace for your kids.", productScopes: ["storage_kitchen"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Cooking is so much more enjoyable in a well-organized kitchen.", productScopes: ["storage_kitchen"], mode: "generative_seeded" },
];

export const HOOKS_SEED: HookSeedEntry[] = [
  ...FR_CAT1, ...FR_CAT2, ...FR_CAT3, ...FR_CAT4, ...FR_CAT5,
  ...EN_CAT1, ...EN_CAT2, ...EN_CAT3, ...EN_CAT4, ...EN_CAT5,
];
