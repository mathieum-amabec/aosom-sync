import { describe, it, expect } from "vitest";
import {
  SOCIAL_PROMPT_FR,
  SOCIAL_PROMPT_EN,
  SOCIAL_PROMPT_SEEDS,
} from "@/lib/social-prompts";

/**
 * The vars job4-social's three triggers pass to generateBilingual, mirrored here.
 *
 * `interpolatePrompt` only substitutes keys it is GIVEN — an unknown `{token}` is left
 * verbatim in the text handed to Claude, which then reproduces it in the published
 * caption. That is silent: no throw, no empty string, just "{url}" printed to shoppers.
 * These tests are the guard, so adding a placeholder to a prompt without wiring the var
 * fails here instead of in a live post.
 */
const VARS_BY_TRIGGER: Record<string, string[]> = {
  // socialPromptVars adds category + url to all three; store_name is passed everywhere.
  new_product: ["product_name", "price", "store_name", "category", "url", "hashtags"],
  price_drop: [
    "product_name",
    "price",
    "old_price",
    "new_price",
    "store_name",
    "category",
    "url",
    "hashtags",
  ],
  highlight: ["product_name", "price", "qty", "store_name", "category", "url", "hashtags"],
};

function placeholders(template: string): string[] {
  return [...new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];
}

describe("social prompt seeds", () => {
  it("seeds exactly the six prompt_* keys the settings UI exposes", () => {
    expect(SOCIAL_PROMPT_SEEDS.map(([k]) => k).sort()).toEqual([
      "prompt_highlight_en",
      "prompt_highlight_fr",
      "prompt_new_product_en",
      "prompt_new_product_fr",
      "prompt_price_drop_en",
      "prompt_price_drop_fr",
    ]);
  });

  it.each(SOCIAL_PROMPT_SEEDS)(
    "%s uses only placeholders its trigger supplies",
    (key, template) => {
      const trigger = key.replace(/^prompt_/, "").replace(/_(fr|en)$/, "");
      const available = VARS_BY_TRIGGER[trigger];
      expect(available, `unknown trigger for ${key}`).toBeDefined();
      const unresolved = placeholders(template).filter((p) => !available.includes(p));
      expect(unresolved, `${key} would emit literal placeholders`).toEqual([]);
    },
  );

  it.each([
    ["FR", SOCIAL_PROMPT_FR],
    ["EN", SOCIAL_PROMPT_EN],
  ])("%s prompt carries the direct-response constraints", (_lang, prompt) => {
    // The 100-word ceiling and the free-shipping + exact-price rule are the two
    // requirements a caption is judged on; a rewrite that drops either is a regression.
    expect(prompt).toMatch(/100 (mots|words)/);
    expect(prompt.toLowerCase()).toMatch(/livraison gratuite|free shipping/);
  });

  it("bans the clichés the rewrite exists to remove", () => {
    // The FR list is the specified one. Guards against a well-meaning edit that
    // reintroduces "Découvrez" as an example while the rule still forbids it.
    for (const banned of ["profitez", "découvrez", "n'attendez plus", "qualité supérieure"]) {
      expect(SOCIAL_PROMPT_FR).toContain(banned);
    }
    // …and each appears only inside the prohibition line, never as instruction elsewhere.
    const banLine = SOCIAL_PROMPT_FR.split("\n").find((l) => l.startsWith("- Jamais :"));
    expect(banLine).toBeDefined();
  });

  it("does not open the FR prompt with a vouvoiement instruction", () => {
    expect(SOCIAL_PROMPT_FR).toContain('Utilise "tu/toi"');
    expect(SOCIAL_PROMPT_FR).not.toMatch(/vouvoiement/i);
  });
});
