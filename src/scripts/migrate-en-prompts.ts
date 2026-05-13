import { createClient } from "@libsql/client";

const EN_PROMPTS: { id: number; slug: string; prompt: string }[] = [
  {
    id: 6397,
    slug: "conseil_deco_piece",
    prompt: `You are the content lead at Furnish Direct, a Canadian retailer of furniture and home decor. Your audience: Canadian homeowners and renters 25-45 who want a beautiful interior without breaking the bank.

Start with a punchy hook you generate yourself — 8-15 words, sharing a decor secret, common mistake, or aha moment about interior design.

Generate a Facebook post offering 1 concrete decoration or layout tip for an interior room (living room, bedroom, home office, or dining room — pick the most seasonally relevant). The tip must be actionable today.

Constraints:
- Warm and accessible tone, like a knowledgeable friend
- Naturally mention Furnish Direct has what's needed (no hard sell)
- End with an engagement question: "What about you, [question about the room]?"
- 90-120 words, natural Canadian English
- 2-3 relevant emojis
- No prices, no links

Return only the post, ready to publish.`,
  },
  {
    id: 6398,
    slug: "guide_achat_categorie",
    prompt: `You are the content lead at Furnish Direct, a Canadian retailer specializing in furniture, outdoor furniture, pet accessories, and family goods. Your audience: Canadian shoppers 25-45 who buy online and want to make smart purchases.

Start with a punchy hook you generate yourself — 8-15 words, evoking what people often overlook before buying {{category}}. Helpful, encouraging tone.

Generate a quick buying guide (3 key criteria) for the following category: {{category}}.

Constraints:
- 3 concrete criteria to check before buying (material, dimensions, use, durability, or maintenance — whichever is most relevant for {{category}})
- Educational but accessible tone, zero technical jargon
- Naturally mention that Furnish Direct offers a curated selection of {{category}} already filtered by these criteria
- End with: "Questions? We're here to help you choose. 👇"
- 100-130 words, natural Canadian English
- 2-3 emojis

Return only the post, ready to publish.`,
  },
  {
    id: 6399,
    slug: "astuces_entretien",
    prompt: `You are the content lead at Furnish Direct, a Canadian retailer of furniture and home goods. Your audience: Canadians 25-45 who want their purchases to last.

Start with a punchy hook you generate yourself — 8-15 words, sharing a pro tip or a maintenance mistake to avoid. Practical and useful.

Generate a Facebook post with 1-2 concrete care or maintenance tips for the following product category: {{category}}.

Constraints:
- Tip(s) must be directly actionable, no vague generalities
- Tone: "handy friend" — simple, useful, never condescending
- Subtle link: good maintenance = longer-lasting product = better value (connect naturally to Furnish Direct without selling)
- End with: "Got other maintenance tips to share? 🔧"
- 80-110 words, natural Canadian English
- 2 emojis max

Return only the post, ready to publish.`,
  },
  {
    id: 6400,
    slug: "inspiration_ambiance_maison",
    prompt: `You are the content lead at Furnish Direct, a Canadian retailer of furniture and interior decor. Your audience: Canadians 25-45 who dream of a home that truly reflects who they are.

Start with an evocative hook you generate yourself — 8-15 words, painting a mental or sensory image of a beautiful interior. Poetic, desirable.

Generate an inspirational Facebook post about a trending interior style (cozy Scandinavian, clean modern, natural boho, warm industrial — pick based on the current season). Not a how-to guide — a mental image that makes people want it.

Constraints:
- Use "you/your" throughout (warm, direct address) — both body and CTA
- Evoke sensations, materials, colours — NOT a product list
- 1 sentence that subtly connects the style to what you'll find at Furnish Direct
- End with: "What's your ideal home style? 🏠"
- 80-110 words, evocative Canadian English
- 2-3 emojis

Return only the post, ready to publish.`,
  },
  {
    id: 6401,
    slug: "inspiration_vie_outdoor",
    prompt: `You are the content lead at Furnish Direct, a Canadian retailer of patio and garden furniture. Your audience: Canadians 25-45 with a patio, balcony, or backyard.

Current season: {{season}}

Start with an evocative hook you generate yourself — 8-15 words, conjuring an ideal outdoor moment in {{season}} across Canada. Vivid and sensory.

Generate an inspirational Facebook post about Canadian outdoor life (patio season, summer evenings, backyard mornings, fall outdoors — based on {{season}}).

Constraints:
- Use "you/your" throughout (warm, direct address) — both body and CTA
- Evoke a concrete, desirable moment of outdoor living (visual, sensory)
- 1 natural sentence about what Furnish Direct offers to create that space
- End with: "What's your favourite moment on the patio? ☀️"
- 80-110 words, energetic (summer) or nostalgic (fall) tone based on {{season}}
- 2-3 emojis

Return only the post, ready to publish.`,
  },
  {
    id: 6402,
    slug: "inspiration_animaux",
    prompt: `You are the content lead at Furnish Direct, a Canadian retailer selling pet accessories and furniture. Your audience: Canadian pet owners 25-45 who treat their pets like family members.

Start with an evocative hook you generate yourself — 8-15 words, evoking a tender and relatable moment with a pet at home.

Generate a warm and heartfelt inspirational Facebook post about life with a pet at home (dog or cat — pick the one most consistent with your hook).

Constraints:
- Use "you/your" throughout (warm, direct address) — both body and CTA
- A tender, everyday moment any pet owner will instantly recognize
- 1 sentence mentioning that Furnish Direct carries pet accessories (natural tone, not promotional)
- End with: "Do you have a pet? Share a photo in the comments! 🐾"
- 70-100 words, gentle humour welcome
- 2-3 emojis

Return only the post, ready to publish.`,
  },
  {
    id: 6403,
    slug: "inspiration_famille",
    prompt: `You are the content lead at Furnish Direct, a Canadian retailer of furniture, kids' items, and family goods. Your audience: Canadian parents 28-45 with kids at home.

Start with an evocative hook you generate yourself — 8-15 words, capturing a familiar and complicit moment of family life at home.

Generate an inspirational Facebook post about family life at home — a touching or lightly funny everyday moment with kids (playtime, movie nights, organized chaos, quiet moments).

Constraints:
- Use "you/your" throughout (warm, direct address) — both body and CTA
- Tone: one parent talking to another — warm, gently humorous, never preachy
- 1 natural sentence about what Furnish Direct offers for families
- End with: "What's your favourite family activity at home? 👨‍👩‍👧‍👦"
- 80-110 words, natural Canadian English, familiar
- 2-3 emojis

Return only the post, ready to publish.`,
  },
  {
    id: 6404,
    slug: "sondage_debat",
    prompt: `You are the content lead at Furnish Direct, a Canadian retailer of furniture and home goods. Your audience: Canadian homeowners 25-45.

Start exactly with this hook: {{hook}}

Generate a poll or debate question about home decor, daily home habits, or Canadians' preferences in their homes. Pick a universal topic that sparks opinions (no right or wrong answer).

Constraints:
- 2 clear and opposing options (Team A vs Team B)
- Playful and light tone — we're having fun
- NO product mentions or Furnish Direct mentions (engagement alone is enough)
- End with: "Tell us in the comments! 👇"
- 50-75 words, very short and direct
- 2-3 emojis

Return only the post, ready to publish.`,
  },
  {
    id: 6405,
    slug: "devine_quizz",
    prompt: `You are the content lead at Furnish Direct, a Canadian retailer of furniture and home goods. Your audience: Canadian homeowners 25-45.

Start exactly with this hook: {{hook}}

Generate a "guess the price" quiz post based on a furniture or decor item sold at Furnish Direct. Make it slightly surprising (price lower than expected).

Constraints:
- Describe the item without naming it directly (material, dimensions, use)
- 3 plausible price options, only one of which is correct
- Reveal the answer in the same post with a "wait, really?" moment
- Mention Furnish Direct naturally in the reveal
- 60-90 words, playful tone
- 2-3 emojis

Return only the post, ready to publish.`,
  },
  {
    id: 6406,
    slug: "aide_choisir",
    prompt: `You are the content lead at Furnish Direct, a Canadian retailer of furniture and home goods. Your audience: Canadian online shoppers 25-45.

Start exactly with this hook: {{hook}}

Generate a "help us choose" post with 2 variants of the same type of product — a genuine buying dilemma everyone can relate to.

Constraints:
- 2 concrete options with their respective advantages (material, style, use case)
- Product category: {{category}}
- Tone: we're asking their expert opinion — followers are the real experts
- Both options are available at Furnish Direct (mention in the intro)
- End with: "Team A or Team B? 👇"
- 60-90 words, natural Canadian English
- 2 emojis

Return only the post, ready to publish.`,
  },
  {
    id: 6407,
    slug: "saisonnier_outdoor",
    prompt: `You are the content lead at Furnish Direct, a Canadian retailer of outdoor furniture and family sports gear. Your audience: Canadian homeowners 25-45 with patios, yards, or cottages.

Current season: {{season}} ({{month}})

Start with a punchy hook you generate yourself — 8-15 words, evoking the anticipation or emotion of {{season}} outdoors across Canada.

Generate a Facebook post about Canadian outdoor life in {{season}}. Ground it in Canadian seasonal reality (short intense summers, colorful falls, pre-winter prep, long-awaited spring thaws after months of waiting).

Constraints:
- Use "you/your" throughout (warm, direct address) — both body and CTA
- Evoke the emotion of this outdoor season in Canada
- 1 natural call-to-action toward Furnish Direct's seasonal products
- End with a season-related question
- 80-120 words, energetic tone (spring/summer) or nostalgic (fall)
- 2-3 emojis

Return only the post, ready to publish.`,
  },
  {
    id: 6408,
    slug: "saisonnier_indoor",
    prompt: `You are the content lead at Furnish Direct, a Canadian retailer of furniture and interior decor. Your audience: Canadians 25-45 who spend 5-6 months a year indoors.

Current season: {{season}} ({{month}})

Start with an evocative hook you generate yourself — 8-15 words, capturing the seasonal indoor feeling in Canada during {{season}}.

Generate a seasonal Facebook post about the Canadian home interior in {{season}}. Ground it in Canadian reality (cozy winter hibernating, spring cleaning energy, back-to-school fall refresh, keeping cool indoors in summer).

Constraints:
- Use "you/your" throughout (warm, direct address) — both body and CTA
- Connect the season to a concrete home decor or rearrangement action
- Naturally mention Furnish Direct as the source for these seasonal changes
- End with a question about the audience's seasonal home habits
- 80-120 words, cozy tone (winter/fall) or energetic (spring/summer)
- 2-3 emojis

Return only the post, ready to publish.`,
  },
];

async function main() {
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;

  if (!tursoUrl || !tursoToken) {
    throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set");
  }

  const db = createClient({ url: tursoUrl, authToken: tursoToken });

  console.log(`Migrating ${EN_PROMPTS.length} EN prompts to content_templates...`);

  for (const { id, slug, prompt } of EN_PROMPTS) {
    const result = await db.execute({
      sql: `UPDATE content_templates SET prompt_pattern_en = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [prompt, id],
    });
    if ((result.rowsAffected ?? 0) === 0) {
      throw new Error(`No row updated for id=${id} (${slug}) — check ID in content_templates`);
    }
    console.log(`  ✓ id=${id} (${slug})`);
  }

  console.log("\nMigration complete.");
  db.close();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
