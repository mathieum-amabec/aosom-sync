import { describe, it, expect } from "vitest";
import { addUtm, tagCaptionLinks, type UtmParams } from "@/lib/utm";

const P: UtmParams = { source: "facebook", medium: "reel", campaign: "vitrine", content: "v546" };
const TAGS = "utm_source=facebook&utm_medium=reel&utm_campaign=vitrine&utm_content=v546";

describe("addUtm", () => {
  it("tags our storefront links, on both brands and with or without www", () => {
    expect(addUtm("https://ameublodirect.ca/products/canape", P)).toBe(`https://ameublodirect.ca/products/canape?${TAGS}`);
    expect(addUtm("https://furnishdirect.ca/products/sofa", P)).toBe(`https://furnishdirect.ca/products/sofa?${TAGS}`);
    expect(addUtm("https://www.ameublodirect.ca/products/canape", P)).toContain("utm_source=facebook");
  });
  it("keeps an existing query and a fragment", () => {
    expect(addUtm("https://ameublodirect.ca/products/c?variant=123#avis", P)).toBe(`https://ameublodirect.ca/products/c?variant=123&${TAGS}#avis`);
  });
  it("never touches a third-party link", () => {
    expect(addUtm("https://www.facebook.com/ameublodirect", P)).toBe("https://www.facebook.com/ameublodirect");
    expect(addUtm("https://ameublodirect.ca.evil.com/x", P)).toBe("https://ameublodirect.ca.evil.com/x");
    expect(addUtm("https://notameublodirect.ca/x", P)).toBe("https://notameublodirect.ca/x");
  });
  it("leaves an already-tagged link alone", () => {
    const tagged = "https://ameublodirect.ca/products/c?utm_source=newsletter";
    expect(addUtm(tagged, P)).toBe(tagged);
  });
  it("leaves garbage alone and does not add a slash to a bare host", () => {
    expect(addUtm("not a url", P)).toBe("not a url");
    expect(addUtm("https://ameublodirect.ca", P)).toBe(`https://ameublodirect.ca?${TAGS}`);
  });
  it("normalises the tag values (lowercase, no spaces or accents-breaking characters)", () => {
    expect(addUtm("https://ameublodirect.ca/p", { ...P, campaign: "Défi Budget!" })).toContain("utm_campaign=d-fi-budget");
  });
});

describe("tagCaptionLinks", () => {
  it("tags every storefront link and keeps the sentence punctuation after it", () => {
    const caption = "Canapé — 244,99 $ : https://ameublodirect.ca/products/canape.\nVoir aussi (https://ameublodirect.ca/products/table), merci !";
    expect(tagCaptionLinks(caption, P)).toBe(
      `Canapé — 244,99 $ : https://ameublodirect.ca/products/canape?${TAGS}.\nVoir aussi (https://ameublodirect.ca/products/table?${TAGS}), merci !`,
    );
  });
  it("is a no-op on a caption without links, and idempotent", () => {
    expect(tagCaptionLinks("Un salon qui se monte tout seul. #maison", P)).toBe("Un salon qui se monte tout seul. #maison");
    const once = tagCaptionLinks("Voir https://ameublodirect.ca/products/a", P);
    expect(tagCaptionLinks(once, P)).toBe(once);
  });
});
