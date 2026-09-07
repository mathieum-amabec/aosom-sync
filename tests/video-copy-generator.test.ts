import { describe, it, expect, vi } from "vitest";
import {
  generateVideoCopy, parseCopyReply, fallbackCopy, normalizeLine, priceFr,
  CAMPAIGN_ANGLE, NEUTRAL_ANGLE, type CopyProduct,
} from "@/lib/video-copy-generator";

vi.mock("@/lib/content-generator", () => ({ getAnthropicClient: () => ({}) }));
vi.mock("@/lib/llm-budget", () => ({ budgetedCreate: vi.fn() }));

const P: CopyProduct = {
  sku: "836-068WT",
  title: "Bureau d'ordinateur 3 tiroirs et étagères réversibles 119 cm",
  price: 164.99,
  productType: "Office Products > Office Furniture > Office Desks",
};

const reply = (hook: string, benefit = "PLUS DE PLACE POUR TRAVAILLER") =>
  JSON.stringify({ hook, benefit, price: "164,99 $ LIVRÉ CHEZ VOUS", cta: "MAGASINEZ SUR AMEUBLODIRECT.CA" });

describe("normalizeLine", () => {
  it("uppercases, strips quotes and emoji, drops trailing punctuation", () => {
    expect(normalizeLine('  "ton bureau déborde" 🎃 ')).toBe("TON BUREAU DÉBORDE");
    expect(normalizeLine("plus de place !")).toBe("PLUS DE PLACE");
  });
  it("keeps accents — this is French copy", () => {
    expect(normalizeLine("étagères réversibles")).toBe("ÉTAGÈRES RÉVERSIBLES");
  });
  it("collapses runs of whitespace", () => {
    expect(normalizeLine("trop   de\n\ndésordre")).toBe("TROP DE DÉSORDRE");
  });
});

describe("priceFr", () => {
  it("formats CAD the Quebec way, with a comma and a trailing sign", () => {
    expect(priceFr(164.99)).toMatch(/^164,99\s\$$/);
    expect(priceFr(1234.5)).toContain(",50");
  });
});

describe("parseCopyReply", () => {
  it("returns four normalized messages", () => {
    const c = parseCopyReply(reply("TON BUREAU DÉBORDE"), P)!;
    expect(c.messages).toHaveLength(4);
    expect(c.hook).toBe("TON BUREAU DÉBORDE");
    expect(c.fallback).toBe(false);
  });

  it("ignores prose around the JSON", () => {
    expect(parseCopyReply(`Voici:\n${reply("A B C")}\nvoilà`, P)?.hook).toBe("A B C");
  });

  // The price slide is the one message that must never be improvised.
  it("rebuilds the price line when the model dropped the figure", () => {
    const bad = JSON.stringify({ hook: "H", benefit: "B", price: "UN PRIX IMBATTABLE", cta: "C" });
    expect(parseCopyReply(bad, P)!.messages[2]).toMatch(/164,99/);
  });

  it("falls back to free shipping when the product has no price at all", () => {
    const noPrice = { ...P, price: null };
    const bad = JSON.stringify({ hook: "H", benefit: "B", price: "", cta: "C" });
    expect(parseCopyReply(bad, noPrice)!.messages[2]).toContain("LIVRAISON GRATUITE");
  });

  it("supplies the standard CTA when the model omitted one", () => {
    const noCta = JSON.stringify({ hook: "H", benefit: "B", price: "10,00 $", cta: "" });
    expect(parseCopyReply(noCta, P)!.messages[3]).toContain("AMEUBLODIRECT.CA");
  });

  it("rejects a reply missing the hook or the benefit", () => {
    expect(parseCopyReply(JSON.stringify({ benefit: "B", price: "1", cta: "C" }), P)).toBeNull();
    expect(parseCopyReply(JSON.stringify({ hook: "H", price: "1", cta: "C" }), P)).toBeNull();
    expect(parseCopyReply("pas de json", P)).toBeNull();
  });
});

describe("fallbackCopy", () => {
  it("still varies by campaign and still carries the real price", () => {
    const a = fallbackCopy(P, "automne-2026");
    const h = fallbackCopy(P, "hiver-2026");
    expect(a.hook).not.toBe(h.hook);
    expect(a.messages[2]).toMatch(/164,99/);
    expect(a.fallback).toBe(true);
  });
  it("uses the product title when the campaign is unknown", () => {
    expect(fallbackCopy(P, "campagne-inconnue").hook).toContain("BUREAU");
  });
});

describe("generateVideoCopy", () => {
  it("returns the model's copy and reports it as model-written", async () => {
    const c = await generateVideoCopy(P, "automne-2026", { complete: async () => reply("TON BUREAU DÉBORDE") });
    expect(c.hook).toBe("TON BUREAU DÉBORDE");
    expect(c.fallback).toBe(false);
  });

  it("puts the campaign angle in the system prompt", async () => {
    let sys = "";
    await generateVideoCopy(P, "animaux-2026", {
      complete: async (s) => { sys = s; return reply("H"); },
    });
    expect(sys).toContain(CAMPAIGN_ANGLE["animaux-2026"]);
  });

  it("uses a neutral angle rather than inventing one for an unknown campaign", async () => {
    let sys = "";
    await generateVideoCopy(P, "inconnue-2030", { complete: async (s) => { sys = s; return reply("H"); } });
    expect(sys).toContain(NEUTRAL_ANGLE);
  });

  it("tells the model which hooks are already taken", async () => {
    let sys = "";
    await generateVideoCopy(P, "automne-2026", {
      usedHooks: ["TON BUREAU DÉBORDE"],
      complete: async (s) => { sys = s; return reply("AUTRE CHOSE"); },
    });
    expect(sys).toContain("TON BUREAU DÉBORDE");
    expect(sys).toMatch(/INTERDIT/);
  });

  // The instruction alone is not enough: models converge on the same phrasing for similar
  // products, which is the exact failure this module exists to prevent.
  it("REJECTS a duplicate hook and retries", async () => {
    const replies = [reply("TON BUREAU DÉBORDE"), reply("TROP DE PAPERASSE")];
    const c = await generateVideoCopy(P, "automne-2026", {
      usedHooks: ["TON BUREAU DÉBORDE"],
      complete: async () => replies.shift()!,
    });
    expect(c.hook).toBe("TROP DE PAPERASSE");
    expect(c.fallback).toBe(false);
  });

  it("treats a case/whitespace variant of a used hook as a duplicate", async () => {
    const replies = [reply("  ton bureau déborde  "), reply("VRAIMENT AUTRE CHOSE")];
    const c = await generateVideoCopy(P, "automne-2026", {
      usedHooks: ["TON BUREAU DÉBORDE"],
      complete: async () => replies.shift()!,
    });
    expect(c.hook).toBe("VRAIMENT AUTRE CHOSE");
  });

  it("falls back after two duplicate attempts rather than shipping a repeat", async () => {
    const c = await generateVideoCopy(P, "automne-2026", {
      usedHooks: ["TON BUREAU DÉBORDE"],
      complete: async () => reply("TON BUREAU DÉBORDE"),
    });
    expect(c.fallback).toBe(true);
  });

  // A campaign of 29 clips must not die on the twelfth.
  it("never throws when the model errors — it falls back", async () => {
    const c = await generateVideoCopy(P, "automne-2026", {
      complete: async () => { throw new Error("529 overloaded"); },
    });
    expect(c.fallback).toBe(true);
    expect(c.messages).toHaveLength(4);
  });

  it("falls back on malformed output", async () => {
    const c = await generateVideoCopy(P, "automne-2026", { complete: async () => "¯\_(ツ)_/¯" });
    expect(c.fallback).toBe(true);
  });

  it("produces a distinct hook for each of several products in one campaign", async () => {
    const hooks = ["TON BUREAU DÉBORDE", "TROP DE PAPERASSE", "LE COIN TRAVAIL EST UN CHANTIER"];
    const used: string[] = [];
    let i = 0;
    for (const sku of ["A", "B", "C"]) {
      const c = await generateVideoCopy({ ...P, sku }, "automne-2026", {
        usedHooks: used,
        complete: async () => reply(hooks[i++]),
      });
      used.push(c.hook);
    }
    expect(new Set(used).size).toBe(3);
  });
});
