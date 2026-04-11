/**
 * Seed initial collection mappings based on Aosom categories → Shopify collections.
 * Run: TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npx tsx scripts/seed-collection-mappings.ts
 */

import { upsertCollectionMappingsBatch } from "../src/lib/database";
import type { CollectionMapping } from "../src/lib/database";

const MAPPINGS: CollectionMapping[] = [
  // Patio & Garden
  { aosomCategory: "Patio & Garden > Patio Furniture", shopifyCollectionId: "312997806185", shopifyCollectionTitle: "Chaises et tables de patio" },
  { aosomCategory: "Patio & Garden > Sun Loungers", shopifyCollectionId: "312997806185", shopifyCollectionTitle: "Chaises et tables de patio" },
  { aosomCategory: "Patio & Garden > Patio Swings & Hammocks", shopifyCollectionId: "312997806185", shopifyCollectionTitle: "Chaises et tables de patio" },
  { aosomCategory: "Patio & Garden > Lawn & Garden", shopifyCollectionId: "312997642345", shopifyCollectionTitle: "Mobiliers extérieurs et jardins" },
  { aosomCategory: "Patio & Garden > Lawn & Garden > Sheds", shopifyCollectionId: "312997642345", shopifyCollectionTitle: "Mobiliers extérieurs et jardins" },
  { aosomCategory: "Patio & Garden > Lawn & Garden > Raised Garden Beds", shopifyCollectionId: "312997740649", shopifyCollectionTitle: "Serres et accessoires de jardinage" },
  { aosomCategory: "Patio & Garden > Wedding & Events Tents", shopifyCollectionId: "312997707881", shopifyCollectionTitle: "Gazébos et abris extérieurs" },
  { aosomCategory: "Patio & Garden > Patio Shade", shopifyCollectionId: "312997642345", shopifyCollectionTitle: "Mobiliers extérieurs et jardins" },
  { aosomCategory: "Patio & Garden > Camping Supplies", shopifyCollectionId: "312998035561", shopifyCollectionTitle: "Équipements d'activités de plein air" },
  { aosomCategory: "Patio & Garden > Outdoor Heating", shopifyCollectionId: "312997642345", shopifyCollectionTitle: "Mobiliers extérieurs et jardins" },
  { aosomCategory: "Patio & Garden > Outdoor Lighting", shopifyCollectionId: "312997642345", shopifyCollectionTitle: "Mobiliers extérieurs et jardins" },

  // Home Furnishings
  { aosomCategory: "Home Furnishings > Kitchen & Dining Furniture", shopifyCollectionId: "312997183593", shopifyCollectionTitle: "Cuisine et salle à manger" },
  { aosomCategory: "Home Furnishings > Living Room Furniture", shopifyCollectionId: "312997085289", shopifyCollectionTitle: "Salon" },
  { aosomCategory: "Home Furnishings > Living Room Furniture > Sofas & Reclining Chairs", shopifyCollectionId: "312997347433", shopifyCollectionTitle: "Fauteuils et canapés" },
  { aosomCategory: "Home Furnishings > Storage & Organization", shopifyCollectionId: "312997281897", shopifyCollectionTitle: "Meubles et décorations" },
  { aosomCategory: "Home Furnishings > Bedroom Furniture", shopifyCollectionId: "312997445737", shopifyCollectionTitle: "Chambre à coucher" },
  { aosomCategory: "Home Furnishings > Bedding & Bath", shopifyCollectionId: "312997576809", shopifyCollectionTitle: "Salle de bain" },
  { aosomCategory: "Home Furnishings > Home Décor", shopifyCollectionId: "312997609577", shopifyCollectionTitle: "Décorations intérieures" },
  { aosomCategory: "Home Furnishings > Entryway Furniture", shopifyCollectionId: "312997544041", shopifyCollectionTitle: "Entrée et vestibule" },

  // Pet Supplies
  { aosomCategory: "Pet Supplies > Cats", shopifyCollectionId: "312998101097", shopifyCollectionTitle: "Chats" },
  { aosomCategory: "Pet Supplies > Dogs", shopifyCollectionId: "312998166633", shopifyCollectionTitle: "Chiens" },
  { aosomCategory: "Pet Supplies > Small Animals", shopifyCollectionId: "312998068329", shopifyCollectionTitle: "Accessoires pour animaux" },
  { aosomCategory: "Pet Supplies > Birds", shopifyCollectionId: "312998068329", shopifyCollectionTitle: "Accessoires pour animaux" },

  // Toys & Games
  { aosomCategory: "Toys & Games", shopifyCollectionId: "312997871721", shopifyCollectionTitle: "Jouets pour enfants" },
  { aosomCategory: "Toys & Games > Kids Outdoor Play", shopifyCollectionId: "312997871721", shopifyCollectionTitle: "Jouets pour enfants" },
  { aosomCategory: "Toys & Games > Baby & Toddler Toys", shopifyCollectionId: "312997871721", shopifyCollectionTitle: "Jouets pour enfants" },
  { aosomCategory: "Toys & Games > Kids Furniture", shopifyCollectionId: "312997904489", shopifyCollectionTitle: "Meubles pour enfants" },

  // Office
  { aosomCategory: "Office Products", shopifyCollectionId: "312997511273", shopifyCollectionTitle: "Bureau" },
  { aosomCategory: "Office Products > Office Furniture", shopifyCollectionId: "312997511273", shopifyCollectionTitle: "Bureau" },

  // Sports & Recreation
  { aosomCategory: "Sports & Recreation", shopifyCollectionId: "312997937257", shopifyCollectionTitle: "Sports et loisirs" },
  { aosomCategory: "Sports & Recreation > Bikes & Scooters", shopifyCollectionId: "312998002793", shopifyCollectionTitle: "Équipements de sport" },
  { aosomCategory: "Sports & Recreation > Lawn Games", shopifyCollectionId: "312997937257", shopifyCollectionTitle: "Sports et loisirs" },
  { aosomCategory: "Sports & Recreation > Exercise & Fitness", shopifyCollectionId: "312998002793", shopifyCollectionTitle: "Équipements de sport" },

  // Other
  { aosomCategory: "Home Improvement", shopifyCollectionId: "312998199401", shopifyCollectionTitle: "Autres" },
  { aosomCategory: "Health & Beauty", shopifyCollectionId: "312998199401", shopifyCollectionTitle: "Autres" },
];

async function main() {
  console.log(`Seeding ${MAPPINGS.length} collection mappings...`);
  await upsertCollectionMappingsBatch(MAPPINGS);
  console.log("Done.");
}

main().catch(err => {
  console.error("Failed:", err);
  process.exit(1);
});
