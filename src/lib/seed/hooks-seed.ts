/**
 * Initial hook pool seed — 200 hooks (100 FR + 100 EN).
 *
 * 5 categories × 20 hooks per category × 2 languages = 200.
 * Each category has 4 universal hooks + 16 scope-specific (3 outdoor_patio + 3 storage_organization
 * + 3 mobilier_indoor + 3 pets_kids + 2 bedroom_bath + 2 home_office).
 *
 * mode: 'pool'             → hook text used verbatim as the draft opener
 *       'generative_seeded' → Claude instructed to vary the hook while keeping its spirit
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
  { id: 1, name_fr: "Inspiration", name_en: "Inspiration", description: "Hooks that spark imagination and desire" },
  { id: 2, name_fr: "Pratique", name_en: "Practical", description: "Hooks that address a real need or problem" },
  { id: 3, name_fr: "Urgence", name_en: "Urgency", description: "Hooks that create FOMO or scarcity tension" },
  { id: 4, name_fr: "Engagement", name_en: "Engagement", description: "Hooks that invite participation or opinion" },
  { id: 5, name_fr: "Saisonnier", name_en: "Seasonal", description: "Hooks tied to seasons, weather or events" },
];

// ─── FR Hooks ─────────────────────────────────────────────────────────

const FR_INSPIRATION: HookSeedEntry[] = [
  // Universal (4)
  { categoryId: 1, language: "FR", text: "Votre maison, c'est votre signature.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Un seul meuble peut transformer toute l'atmosphère d'une pièce.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Le bon choix aujourd'hui, le coup de cœur pour toujours.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Chaque espace mérite d'être beau et fonctionnel.", productScopes: ["universal"], mode: "generative_seeded" },
  // outdoor_patio (3)
  { categoryId: 1, language: "FR", text: "Imaginez votre terrasse parfaite — café du matin, soir entre amis.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Un patio bien aménagé, c'est une pièce de plus à profiter tout l'été.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Votre cour arrière peut devenir votre endroit préféré au Québec.", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // storage_organization (3)
  { categoryId: 1, language: "FR", text: "L'ordre, c'est la liberté. Un espace rangé, un esprit léger.", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Quand tout a sa place, la maison respire différemment.", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Un rangement intelligent, c'est de l'espace récupéré.", productScopes: ["storage_organization"], mode: "generative_seeded" },
  // mobilier_indoor (3)
  { categoryId: 1, language: "FR", text: "Votre salon devrait vous ressembler autant que vos vêtements.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Un canapé parfait, c'est l'invitation à ralentir.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Le mobilier qu'on choisit raconte notre façon de vivre.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // pets_kids (3)
  { categoryId: 1, language: "FR", text: "Parce que leur bonheur, c'est votre bonheur.", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Un espace pensé pour eux, avec amour.", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Ils méritent un coin à eux dans votre maison.", productScopes: ["pets_kids"], mode: "generative_seeded" },
  // bedroom_bath (2)
  { categoryId: 1, language: "FR", text: "La chambre, c'est votre sanctuaire — elle mérite le meilleur.", productScopes: ["bedroom_bath"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Bien dormir commence avec l'environnement qu'on crée.", productScopes: ["bedroom_bath"], mode: "generative_seeded" },
  // home_office (2)
  { categoryId: 1, language: "FR", text: "Votre espace de travail devrait vous inspirer, pas vous épuiser.", productScopes: ["home_office"], mode: "pool" },
  { categoryId: 1, language: "FR", text: "Un bureau bien aménagé, c'est une productivité retrouvée.", productScopes: ["home_office"], mode: "generative_seeded" },
];

const FR_PRATIQUE: HookSeedEntry[] = [
  // Universal (4)
  { categoryId: 2, language: "FR", text: "Qualité durable. Prix honnête. Livraison rapide.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Ce dont vous avez besoin, au prix qui fait sens.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Fini les compromis entre beau et abordable.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Pratique au quotidien, solide sur le long terme.", productScopes: ["universal"], mode: "generative_seeded" },
  // outdoor_patio (3)
  { categoryId: 2, language: "FR", text: "Comment choisir des meubles de patio qui tiennent plus d'une saison.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Résistant aux intempéries, facile à entretenir — voilà ce qu'on cherche.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Pour les hivers québécois : choisir des meubles extérieurs qui survivent.", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // storage_organization (3)
  { categoryId: 2, language: "FR", text: "Enfin une solution de rangement qui fonctionne vraiment.", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Optimiser chaque mètre carré — c'est possible avec le bon meuble.", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Rangement visible, organisation invisible — le secret des maisons bien tenues.", productScopes: ["storage_organization"], mode: "generative_seeded" },
  // mobilier_indoor (3)
  { categoryId: 2, language: "FR", text: "Un meuble solide qui s'adapte à votre espace, pas l'inverse.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Style + durabilité, sans vider votre compte en banque.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Chercher le bon meuble peut prendre des semaines — ou 5 minutes ici.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // pets_kids (3)
  { categoryId: 2, language: "FR", text: "Facile à nettoyer, difficile à abîmer — parfait avec des enfants.", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Nos animaux aussi méritent un équipement de qualité.", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Solide, sécuritaire, lavable — tout ce qu'on veut pour eux.", productScopes: ["pets_kids"], mode: "generative_seeded" },
  // bedroom_bath (2)
  { categoryId: 2, language: "FR", text: "Investir dans un bon sommeil, c'est investir dans tout le reste.", productScopes: ["bedroom_bath"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Rangement chambre : libérez de l'espace, libérez votre esprit.", productScopes: ["bedroom_bath"], mode: "generative_seeded" },
  // home_office (2)
  { categoryId: 2, language: "FR", text: "Télétravail confortable = performance réelle. L'équipement compte.", productScopes: ["home_office"], mode: "pool" },
  { categoryId: 2, language: "FR", text: "Ergonomie, organisation, lumière — les 3 piliers d'un home office qui marche.", productScopes: ["home_office"], mode: "generative_seeded" },
];

const FR_URGENCE: HookSeedEntry[] = [
  // Universal (4)
  { categoryId: 3, language: "FR", text: "Stock limité. Les prix montent. Aujourd'hui, c'est le bon moment.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Ce prix ne durera pas. On vous a prévenus.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Dernière chance avant rupture de stock.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Quand c'est parti, c'est parti. Les indécis regrettent.", productScopes: ["universal"], mode: "generative_seeded" },
  // outdoor_patio (3)
  { categoryId: 3, language: "FR", text: "La saison patio arrive vite — et les bons meubles partent encore plus vite.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Commander maintenant pour recevoir avant l'été.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Chaque printemps, les stocks s'épuisent avant la canicule.", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // storage_organization (3)
  { categoryId: 3, language: "FR", text: "Offre à durée limitée sur cette unité de rangement best-seller.", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Il nous en reste {qty} en stock. Après, on ne sait pas.", productScopes: ["storage_organization"], mode: "generative_seeded" },
  { categoryId: 3, language: "FR", text: "Profitez du prix avant la prochaine livraison.", productScopes: ["storage_organization"], mode: "generative_seeded" },
  // mobilier_indoor (3)
  { categoryId: 3, language: "FR", text: "Ce modèle est demandé — il ne restera pas longtemps.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Prix promotionnel disponible pour quelques jours seulement.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Dernier lot disponible de ce canapé — ne tardez pas.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // pets_kids (3)
  { categoryId: 3, language: "FR", text: "Dernier lot disponible de cet arbre à chat best-seller.", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Stock quasi épuisé — commandez avant la rupture.", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Vos enfants le veulent, le stock fond — agissez.", productScopes: ["pets_kids"], mode: "generative_seeded" },
  // bedroom_bath (2)
  { categoryId: 3, language: "FR", text: "Prix spécial sur cette collection chambre — durée limitée.", productScopes: ["bedroom_bath"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Dernières unités disponibles avant réapprovisionnement incertain.", productScopes: ["bedroom_bath"], mode: "generative_seeded" },
  // home_office (2)
  { categoryId: 3, language: "FR", text: "Prix étudiant limité dans le temps — parfait pour la rentrée.", productScopes: ["home_office"], mode: "pool" },
  { categoryId: 3, language: "FR", text: "Bureau de travail en stock limité — commandez pendant que c'est disponible.", productScopes: ["home_office"], mode: "generative_seeded" },
];

const FR_ENGAGEMENT: HookSeedEntry[] = [
  // Universal (4)
  { categoryId: 4, language: "FR", text: "Si vous pouviez changer une chose chez vous demain, ce serait quoi?", productScopes: ["universal"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Meuble pratique ou meuble beau? Pourquoi choisir.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "On est curieux : vous achetez vos meubles en ligne ou en magasin?", productScopes: ["universal"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Avant/après : la transformation d'une pièce grâce à un seul meuble.", productScopes: ["universal"], mode: "generative_seeded" },
  // outdoor_patio (3)
  { categoryId: 4, language: "FR", text: "Terrasse ou cour? Montrez-nous votre espace extérieur préféré!", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Qu'est-ce que vous faites en premier sur votre patio le matin?", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Vote : parasol ou pergola pour l'été québécois?", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // storage_organization (3)
  { categoryId: 4, language: "FR", text: "Rangement minimaliste ou tout en ordre visible? On débat.", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Quelle pièce dans votre maison a le plus besoin de rangement?", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Team plancard ou team étagères ouvertes? Commentez!", productScopes: ["storage_organization"], mode: "generative_seeded" },
  // mobilier_indoor (3)
  { categoryId: 4, language: "FR", text: "Canapé droit ou canapé d'angle? Le grand débat de salon.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Quelle couleur de meuble ne vieillira jamais selon vous?", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Table basse ou ottoman? Qu'est-ce qui trône dans votre salon?", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // pets_kids (3)
  { categoryId: 4, language: "FR", text: "Chien ou chat? Et est-ce qu'il vole votre place sur le canapé?", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Montrez-nous le coin préféré de votre animal dans votre maison.", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "On veut voir vos enfants dans leur espace de jeu — partagez!", productScopes: ["pets_kids"], mode: "generative_seeded" },
  // bedroom_bath (2)
  { categoryId: 4, language: "FR", text: "Vous faites votre lit tous les matins? Honnêtement.", productScopes: ["bedroom_bath"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Chambre ultra minimaliste ou chambre cocooning? Votre style?", productScopes: ["bedroom_bath"], mode: "generative_seeded" },
  // home_office (2)
  { categoryId: 4, language: "FR", text: "Bureau debout ou assis? Est-ce que ça change vraiment la vie?", productScopes: ["home_office"], mode: "pool" },
  { categoryId: 4, language: "FR", text: "Montrez-nous votre setup de télétravail — les bons, les mauvais, les honnêtes.", productScopes: ["home_office"], mode: "generative_seeded" },
];

const FR_SAISONNIER: HookSeedEntry[] = [
  // Universal (4)
  { categoryId: 5, language: "FR", text: "Nouvelle saison, nouvelle ambiance dans votre maison.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "Le changement de saison, c'est l'occasion parfaite de rafraîchir votre déco.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "Automne = intérieur cocooning. On a ce qu'il faut.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "Préparez votre maison pour la prochaine saison — avant tout le monde.", productScopes: ["universal"], mode: "generative_seeded" },
  // outdoor_patio (3)
  { categoryId: 5, language: "FR", text: "Le printemps arrive — est-ce que votre patio est prêt?", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "L'été québécois est court — profitez-en à fond avec la bonne terrasse.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "Avant que l'automne arrive, équipez votre patio pour les derniers beaux jours.", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // storage_organization (3)
  { categoryId: 5, language: "FR", text: "Grand ménage de printemps : commencez par le rangement.", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "Rentrée scolaire = besoin urgent d'organisation à la maison.", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "En hiver, on passe plus de temps chez soi — autant que ce soit bien rangé.", productScopes: ["storage_organization"], mode: "generative_seeded" },
  // mobilier_indoor (3)
  { categoryId: 5, language: "FR", text: "Hiver québécois + bon canapé = combo parfait.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "Rénovation d'automne : on commence par le salon.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "Chaleur de l'hiver ou fraîcheur de l'été — votre intérieur doit s'adapter.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // pets_kids (3)
  { categoryId: 5, language: "FR", text: "Retour à l'école : créez un vrai espace de travail pour vos enfants.", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "L'hiver, vos animaux restent à l'intérieur — ont-ils leur coin confort?", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "Les fêtes approchent : pensez aux cadeaux pour les petits (et les poilus).", productScopes: ["pets_kids"], mode: "generative_seeded" },
  // bedroom_bath (2)
  { categoryId: 5, language: "FR", text: "Hiver = draps chauds, chambre cocooning. On s'équipe.", productScopes: ["bedroom_bath"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "Printemps : rafraîchissez votre chambre avec quelques nouveautés.", productScopes: ["bedroom_bath"], mode: "generative_seeded" },
  // home_office (2)
  { categoryId: 5, language: "FR", text: "Rentrée = reprise du télétravail. Votre bureau est-il à la hauteur?", productScopes: ["home_office"], mode: "pool" },
  { categoryId: 5, language: "FR", text: "Nouvelles résolutions de janvier : commencez par un bureau qui inspire.", productScopes: ["home_office"], mode: "generative_seeded" },
];

// ─── EN Hooks ─────────────────────────────────────────────────────────

const EN_INSPIRATION: HookSeedEntry[] = [
  // Universal (4)
  { categoryId: 1, language: "EN", text: "Your home is your signature — make it count.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "One great piece of furniture can transform an entire room.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "The right choice today becomes the piece you love forever.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "Every space deserves to be both beautiful and functional.", productScopes: ["universal"], mode: "generative_seeded" },
  // outdoor_patio (3)
  { categoryId: 1, language: "EN", text: "Picture your perfect patio — morning coffee, summer evenings with friends.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "A well-designed patio is basically an extra room all summer long.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "Your backyard could be your favourite spot in the country.", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // storage_organization (3)
  { categoryId: 1, language: "EN", text: "A tidy space is a free mind — it starts with the right storage.", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "When everything has a place, the whole home feels different.", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "Smart storage means getting back the space you forgot you had.", productScopes: ["storage_organization"], mode: "generative_seeded" },
  // mobilier_indoor (3)
  { categoryId: 1, language: "EN", text: "Your living room should reflect you as much as your wardrobe.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "The perfect sofa is an open invitation to slow down.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "The furniture we choose tells the story of how we live.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // pets_kids (3)
  { categoryId: 1, language: "EN", text: "Because their happiness is your happiness.", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "A space designed for them, with love.", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "They deserve their own corner in your home.", productScopes: ["pets_kids"], mode: "generative_seeded" },
  // bedroom_bath (2)
  { categoryId: 1, language: "EN", text: "Your bedroom is your sanctuary — it deserves the best.", productScopes: ["bedroom_bath"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "Great sleep starts with the environment you create.", productScopes: ["bedroom_bath"], mode: "generative_seeded" },
  // home_office (2)
  { categoryId: 1, language: "EN", text: "Your workspace should energize you, not drain you.", productScopes: ["home_office"], mode: "pool" },
  { categoryId: 1, language: "EN", text: "A well-organized desk is the first step to a productive day.", productScopes: ["home_office"], mode: "generative_seeded" },
];

const EN_PRACTICAL: HookSeedEntry[] = [
  // Universal (4)
  { categoryId: 2, language: "EN", text: "Quality that lasts. Honest price. Fast delivery.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "What you need, at a price that makes sense.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "No more choosing between style and affordability.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Built for everyday use. Made to last.", productScopes: ["universal"], mode: "generative_seeded" },
  // outdoor_patio (3)
  { categoryId: 2, language: "EN", text: "How to choose outdoor furniture that survives more than one season.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Weather-resistant, easy to maintain — that's what outdoor furniture should be.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Canadian winters are no joke — choose patio furniture built to survive them.", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // storage_organization (3)
  { categoryId: 2, language: "EN", text: "Finally, a storage solution that actually works.", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Maximize every square foot with the right piece.", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Visible storage, invisible clutter — the secret to a well-kept home.", productScopes: ["storage_organization"], mode: "generative_seeded" },
  // mobilier_indoor (3)
  { categoryId: 2, language: "EN", text: "Furniture that fits your space — not the other way around.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Style and durability, without breaking the bank.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Finding the right sofa can take weeks — or 5 minutes here.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // pets_kids (3)
  { categoryId: 2, language: "EN", text: "Easy to clean, hard to damage — perfect for families with kids.", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Our pets deserve quality gear too.", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Durable, safe, washable — everything you want for them.", productScopes: ["pets_kids"], mode: "generative_seeded" },
  // bedroom_bath (2)
  { categoryId: 2, language: "EN", text: "Investing in good sleep is investing in everything else.", productScopes: ["bedroom_bath"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Bedroom storage: reclaim your space, reclaim your calm.", productScopes: ["bedroom_bath"], mode: "generative_seeded" },
  // home_office (2)
  { categoryId: 2, language: "EN", text: "A comfortable home office means real productivity. The setup matters.", productScopes: ["home_office"], mode: "pool" },
  { categoryId: 2, language: "EN", text: "Ergonomics, organization, lighting — the 3 pillars of a home office that works.", productScopes: ["home_office"], mode: "generative_seeded" },
];

const EN_URGENCY: HookSeedEntry[] = [
  // Universal (4)
  { categoryId: 3, language: "EN", text: "Limited stock. Prices are rising. Today is the right time.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "This price won't last. Don't say we didn't warn you.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "Last chance before this sells out.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "When it's gone, it's gone. The undecided always regret it.", productScopes: ["universal"], mode: "generative_seeded" },
  // outdoor_patio (3)
  { categoryId: 3, language: "EN", text: "Patio season is coming fast — and the good furniture goes even faster.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "Order now to receive before summer hits.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "Every spring, stock runs out before the heat arrives.", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // storage_organization (3)
  { categoryId: 3, language: "EN", text: "Limited-time offer on this best-selling storage unit.", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "Only a few units left in stock — after that, we're not sure.", productScopes: ["storage_organization"], mode: "generative_seeded" },
  { categoryId: 3, language: "EN", text: "Lock in the price before the next shipment changes things.", productScopes: ["storage_organization"], mode: "generative_seeded" },
  // mobilier_indoor (3)
  { categoryId: 3, language: "EN", text: "This model is in high demand — it won't stick around.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "Promotional pricing available for a few days only.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "Last batch of this sofa available — don't wait.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // pets_kids (3)
  { categoryId: 3, language: "EN", text: "Last lot of this best-selling cat tree in stock.", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "Nearly sold out — order before it's gone.", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "Your kids want it, stock is melting — act now.", productScopes: ["pets_kids"], mode: "generative_seeded" },
  // bedroom_bath (2)
  { categoryId: 3, language: "EN", text: "Special pricing on this bedroom collection — limited time.", productScopes: ["bedroom_bath"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "Last units available before uncertain restocking.", productScopes: ["bedroom_bath"], mode: "generative_seeded" },
  // home_office (2)
  { categoryId: 3, language: "EN", text: "Back-to-school deal, time-limited — perfect for the new semester.", productScopes: ["home_office"], mode: "pool" },
  { categoryId: 3, language: "EN", text: "Work desk in limited stock — order while it's available.", productScopes: ["home_office"], mode: "generative_seeded" },
];

const EN_ENGAGEMENT: HookSeedEntry[] = [
  // Universal (4)
  { categoryId: 4, language: "EN", text: "If you could change one thing about your home tomorrow, what would it be?", productScopes: ["universal"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "Practical furniture or beautiful furniture? Why choose.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "Curious: do you buy furniture online or in store?", productScopes: ["universal"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "Before and after: how one piece of furniture can transform a room.", productScopes: ["universal"], mode: "generative_seeded" },
  // outdoor_patio (3)
  { categoryId: 4, language: "EN", text: "Deck or backyard? Show us your favourite outdoor space!", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "What's the first thing you do on your patio in the morning?", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "Vote: umbrella or pergola for the Canadian summer?", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // storage_organization (3)
  { categoryId: 4, language: "EN", text: "Minimalist storage or everything visible and organized? Debate time.", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "Which room in your home needs storage help the most?", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "Team closed cabinets or team open shelving? Comment below!", productScopes: ["storage_organization"], mode: "generative_seeded" },
  // mobilier_indoor (3)
  { categoryId: 4, language: "EN", text: "Straight sofa or sectional? The great living room debate.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "What furniture colour will never go out of style in your opinion?", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "Coffee table or ottoman? What's the centrepiece of your living room?", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // pets_kids (3)
  { categoryId: 4, language: "EN", text: "Dog or cat? And do they steal your spot on the couch?", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "Show us your pet's favourite spot in your home.", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "We want to see your kids in their play space — share the photos!", productScopes: ["pets_kids"], mode: "generative_seeded" },
  // bedroom_bath (2)
  { categoryId: 4, language: "EN", text: "Do you make your bed every morning? Be honest.", productScopes: ["bedroom_bath"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "Ultra minimalist bedroom or cosy retreat? What's your style?", productScopes: ["bedroom_bath"], mode: "generative_seeded" },
  // home_office (2)
  { categoryId: 4, language: "EN", text: "Standing desk or sitting desk? Does it actually change your life?", productScopes: ["home_office"], mode: "pool" },
  { categoryId: 4, language: "EN", text: "Show us your WFH setup — the good, the bad, the honest.", productScopes: ["home_office"], mode: "generative_seeded" },
];

const EN_SEASONAL: HookSeedEntry[] = [
  // Universal (4)
  { categoryId: 5, language: "EN", text: "New season, new vibe in your home.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Season change is the perfect excuse to refresh your décor.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Fall = cosy indoors. We have exactly what you need.", productScopes: ["universal"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Get your home ready for the next season — before everyone else.", productScopes: ["universal"], mode: "generative_seeded" },
  // outdoor_patio (3)
  { categoryId: 5, language: "EN", text: "Spring is coming — is your patio ready?", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Canadian summers are short — make the most of yours with the right setup.", productScopes: ["outdoor_patio"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Before fall hits, gear up your patio for the last warm days.", productScopes: ["outdoor_patio"], mode: "generative_seeded" },
  // storage_organization (3)
  { categoryId: 5, language: "EN", text: "Spring cleaning? Start with storage.", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Back to school = urgent need for organization at home.", productScopes: ["storage_organization"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Winter means more time indoors — might as well keep it tidy.", productScopes: ["storage_organization"], mode: "generative_seeded" },
  // mobilier_indoor (3)
  { categoryId: 5, language: "EN", text: "Canadian winter + great couch = perfect combo.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Fall renovation: start with the living room.", productScopes: ["mobilier_indoor"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Warm in winter, cool in summer — your interior should adapt.", productScopes: ["mobilier_indoor"], mode: "generative_seeded" },
  // pets_kids (3)
  { categoryId: 5, language: "EN", text: "Back to school: build a real study space for your kids.", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Winter keeps pets indoors — do they have a cosy corner?", productScopes: ["pets_kids"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "The holidays are coming: think about gifts for the little ones (and the furry ones).", productScopes: ["pets_kids"], mode: "generative_seeded" },
  // bedroom_bath (2)
  { categoryId: 5, language: "EN", text: "Winter = warm sheets, cosy bedroom. Time to upgrade.", productScopes: ["bedroom_bath"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "Spring: refresh your bedroom with a few new pieces.", productScopes: ["bedroom_bath"], mode: "generative_seeded" },
  // home_office (2)
  { categoryId: 5, language: "EN", text: "Back to work season: is your home office ready for it?", productScopes: ["home_office"], mode: "pool" },
  { categoryId: 5, language: "EN", text: "January resolutions: start with a desk that actually inspires you.", productScopes: ["home_office"], mode: "generative_seeded" },
];

export const HOOKS_SEED: HookSeedEntry[] = [
  ...FR_INSPIRATION,
  ...FR_PRATIQUE,
  ...FR_URGENCE,
  ...FR_ENGAGEMENT,
  ...FR_SAISONNIER,
  ...EN_INSPIRATION,
  ...EN_PRACTICAL,
  ...EN_URGENCY,
  ...EN_ENGAGEMENT,
  ...EN_SEASONAL,
];
