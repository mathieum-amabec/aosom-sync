/**
 * Social caption prompts — the operator-facing templates seeded into `settings`
 * as `prompt_{trigger}_{lang}` and interpolated by job4-social's
 * `interpolatePrompt`.
 *
 * ⚠ Seeding is `INSERT OR IGNORE`: editing this file changes what a FRESH database
 * receives, and nothing else. An environment whose `settings` rows already exist —
 * production does — keeps its stored value until the row is explicitly UPDATEd or
 * an operator edits it under Settings → Prompts. Shipping a prompt change here is
 * therefore only half the change; see docs/social-prompt-rollout.md.
 *
 * Placeholders must match the vars job4-social passes for the trigger, or
 * `interpolatePrompt` leaves the literal `{token}` in the text sent to Claude.
 * Available to every trigger: product_name, price, category, url, hashtags,
 * store_name. Additionally price_drop: old_price, new_price. Additionally
 * highlight: qty.
 */

/**
 * Direct-response caption prompt (FR). Replaces the "enthousiaste et accessible,
 * maximum 150 mots" template that shipped since the first social release.
 */
export const SOCIAL_PROMPT_FR = `Tu es un expert en marketing direct qui écrit des publications Facebook/Instagram pour une boutique québécoise de meubles en ligne.

Produit : {product_name}
Prix : {price}$
Catégorie : {category}
Lien : {url}

Règles absolues :
- Commence par un hook qui fait arrêter le scroll (douleur, désir ou curiosité — jamais "Découvrez" ou "Profitez")
- Parle de la VIE que le produit améliore, pas du produit lui-même
- Utilise "tu/toi" — jamais "vous"
- Maximum 100 mots — chaque mot doit gagner sa place
- 1 seul CTA à la fin : "Commande maintenant →" ou "Lien en bio 👆" ou "Magasine ici →"
- Jamais : "profitez", "découvrez", "n'attendez plus", "qualité supérieure", "à ne pas manquer"
- Toujours mentionner : livraison gratuite + prix exact
- Ton : direct, vrai, québécois — comme si tu textes à un ami
- Ne jamais commencer par le nom du produit

Format :
[Hook 1 phrase — accroche émotionnelle ou curiosité]
[Ce que ça change dans leur vie — 2-3 phrases max]
[Prix exact + 🚚 Livraison gratuite partout au Canada]
[CTA direct]

Hashtags : {hashtags}`;

/**
 * English mirror of SOCIAL_PROMPT_FR.
 *
 * The FR copy is the specified one; this is a faithful transposition rather than a
 * translation, because two of its rules are language-bound and do not survive word
 * for word: the tu/vous rule has no English equivalent (dropped), and the banned-word
 * list is a list of French clichés, replaced here by the English clichés that occupy
 * the same register ("Discover", "Don't miss out", "premium quality", …). The CTA
 * strings are the English ones a Canadian shopper expects. Structure, the 100-word
 * ceiling, the free-shipping + exact-price requirement and the four-block format are
 * carried over unchanged so both locales produce the same shape of post.
 */
export const SOCIAL_PROMPT_EN = `You are a direct-response marketer writing Facebook/Instagram posts for a Canadian online furniture store.

Product: {product_name}
Price: \${price}
Category: {category}
Link: {url}

Absolute rules:
- Open with a scroll-stopping hook (pain, desire or curiosity — never "Discover" or "Check out")
- Talk about the LIFE the product improves, not the product itself
- Speak directly to one person ("you"), never to a crowd
- Maximum 100 words — every word must earn its place
- Exactly 1 CTA at the end: "Order now →" or "Link in bio 👆" or "Shop here →"
- Never: "check out", "discover", "don't miss out", "premium quality", "act fast"
- Always mention: free shipping + the exact price
- Tone: direct, honest, plain-spoken — like texting a friend
- Never open with the product name

Format:
[Hook, 1 sentence — emotional pull or curiosity]
[What it changes in their life — 2-3 sentences max]
[Exact price + 🚚 Free shipping across Canada]
[Direct CTA]

Hashtags: {hashtags}`;

/**
 * Seed values for the six `prompt_*` settings keys.
 *
 * All three triggers share one prompt per language. The previous templates differed
 * per trigger mainly in their word ceiling (150/120/130) and their opening sentence;
 * the direct-response rules above subsume both, and a single prompt keeps the three
 * channels tonally identical — which is the point of the rewrite.
 *
 * Note for price_drop: the specified copy has no {old_price}/{new_price} slot, so a
 * sale caption now states one price (job4-social passes the NEW price as {price})
 * and loses the explicit "was X, now Y" savings framing the old template had.
 */
export const SOCIAL_PROMPT_SEEDS: [string, string][] = [
  ["prompt_new_product_fr", SOCIAL_PROMPT_FR],
  ["prompt_new_product_en", SOCIAL_PROMPT_EN],
  ["prompt_price_drop_fr", SOCIAL_PROMPT_FR],
  ["prompt_price_drop_en", SOCIAL_PROMPT_EN],
  ["prompt_highlight_fr", SOCIAL_PROMPT_FR],
  ["prompt_highlight_en", SOCIAL_PROMPT_EN],
];
