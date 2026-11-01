import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => {
  class QueueSlotTakenError extends Error {}
  return {
    QueueSlotTakenError,
    addToQueue: vi.fn(),
    cancelPendingQueueItems: vi.fn(),
    createNotification: vi.fn(),
    getSetting: vi.fn(),
    ensureSchema: vi.fn(),
  };
});
vi.mock("@/lib/database", () => db);
vi.mock("@/lib/content-generator", () => ({ getAnthropicClient: () => ({}) }));
vi.mock("@/lib/semaine/store", () => ({ getPost: vi.fn(), savePost: vi.fn(), recentSkus: vi.fn(), recentPosts: vi.fn() }));
const shopify = vi.hoisted(() => ({ resolveProductFields: vi.fn() }));
vi.mock("@/lib/selectors/shopify-product", () => shopify);

import { localDay, plannedFormat, MORNING_FORMAT, seasonalMoment, featuredOrder, CHRISTMAS_CATEGORIES } from "@/lib/semaine/formats";
import { shortEnglishTitle, verifyUntil, inCooldown, productKey } from "@/lib/semaine/live";
import { validateBody, factsBlock, assemble, buildCaptions, formatPrice, bodyPrompt, footer } from "@/lib/semaine/caption";
import { runSemaine, type RunDeps } from "@/lib/semaine/run";
import * as store from "@/lib/semaine/store";
import type { LiveProduct, PlannedPost } from "@/lib/semaine/types";

const product = (o: Partial<LiveProduct> = {}): LiveProduct => ({
  sku: "A-1", shopifyProductId: "1", titleFr: "Bureau mural rabattable 150 cm", titleEn: "Fold-out Convertible Office Desk",
  price: 147.99, compareAt: null, handle: "bureau-mural", imageUrl: "https://cdn.shopify.com/a.jpg", productType: "Office Desks", ...o,
});
const plan = (o: Partial<PlannedPost> = {}): PlannedPost => ({ format: "vedette", label: "Produit vedette", products: [product()], maxProducts: 1, ...o });

describe("calendar", () => {
  it("maps weekdays to the weekly formats", () => {
    expect(MORNING_FORMAT[1]).toBe("nouveautes");
    expect(MORNING_FORMAT[0]).toBe("coeur");
    expect(Object.keys(MORNING_FORMAT)).toHaveLength(7);
  });
  it("uses the Toronto calendar day, not UTC", () => {
    // Monday 2026-10-12 03:00Z is still Sunday evening in Toronto.
    expect(localDay(new Date("2026-10-12T03:00:00Z")).weekday).toBe(0);
    expect(localDay(new Date("2026-10-12T12:00:00Z")).weekday).toBe(1);
    expect(localDay(new Date("2026-10-12T12:00:00Z")).date).toBe("2026-10-12");
  });
  it("afternoon is always the featured product", () => {
    expect(plannedFormat(localDay(new Date("2026-10-13T12:00:00Z")), "afternoon")).toBe("vedette");
    expect(plannedFormat(localDay(new Date("2026-10-13T12:00:00Z")), "morning")).toBe("baisses");
  });
});

describe("seasonal layer (Black Friday 2026 + Christmas)", () => {
  // Noon UTC = morning in Toronto, same calendar day.
  const d = (date: string) => localDay(new Date(`${date}T16:00:00Z`));

  it("maps the 2026 dates to their sales moment", () => {
    expect(seasonalMoment(d("2026-11-05"))).toBeNull();
    expect(seasonalMoment(d("2026-11-06"))).toBe("early-bf");
    expect(seasonalMoment(d("2026-11-26"))).toBe("early-bf");
    expect(seasonalMoment(d("2026-11-27"))).toBe("black-friday");
    expect(seasonalMoment(d("2026-11-29"))).toBe("black-friday");
    expect(seasonalMoment(d("2026-11-30"))).toBe("cyber-monday");
    expect(seasonalMoment(d("2026-12-01"))).toBe("noel");
    expect(seasonalMoment(d("2026-12-15"))).toBe("noel");
    expect(seasonalMoment(d("2026-12-16"))).toBeNull();
    expect(seasonalMoment(d("2027-11-27"))).toBeNull(); // next year's dates are set on purpose, not guessed
  });

  it("uses the Toronto day at the edges (Nov 6 starts at midnight Toronto, not UTC)", () => {
    expect(seasonalMoment(localDay(new Date("2026-11-06T03:00:00Z")))).toBeNull(); // still Nov 5, 22:00 Toronto
    expect(seasonalMoment(localDay(new Date("2026-11-06T06:00:00Z")))).toBe("early-bf");
  });

  it("runs baisses on weekday mornings of the early sale, keeps the weekend formats", () => {
    expect(plannedFormat(d("2026-11-09"), "morning")).toBe("baisses"); // Monday (normally nouveautés)
    expect(plannedFormat(d("2026-11-12"), "morning")).toBe("baisses"); // Thursday (normally A/B)
    expect(plannedFormat(d("2026-11-07"), "morning")).toBe("astuce"); // Saturday
    expect(plannedFormat(d("2026-11-08"), "morning")).toBe("coeur"); // Sunday
    expect(plannedFormat(d("2026-11-09"), "afternoon")).toBe("vedette");
  });

  it("runs baisses every morning from Black Friday to Cyber Monday", () => {
    for (const date of ["2026-11-27", "2026-11-28", "2026-11-29", "2026-11-30"]) expect(plannedFormat(d(date), "morning")).toBe("baisses");
  });

  it("is back to the usual calendar outside the sale", () => {
    expect(plannedFormat(d("2026-11-02"), "morning")).toBe("nouveautes");
    expect(plannedFormat(d("2026-12-02"), "morning")).toBe("piece");
  });

  it("puts Christmas categories in the vedette rotation from Nov 1 to Dec 15 only", () => {
    expect(featuredOrder(d("2026-10-31")).some((p) => p.includes("Christmas"))).toBe(false);
    expect(featuredOrder(d("2026-12-16")).some((p) => p.includes("Christmas"))).toBe(false);
    const nov = [d("2026-11-10"), d("2026-11-11")].map((x) => featuredOrder(x)[0]);
    expect(nov.filter((p) => CHRISTMAS_CATEGORIES.includes(p))).toHaveLength(1); // first every other day in November
    expect(CHRISTMAS_CATEGORIES).toContain(featuredOrder(d("2026-12-05"))[0]); // first every day in December
    expect(featuredOrder(d("2026-11-11"))).toEqual(expect.arrayContaining(CHRISTMAS_CATEGORIES));
  });

  it("Christmas patterns match both product_type forms", () => {
    const like = (pattern: string, s: string) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`).test(s);
    expect(like(CHRISTMAS_CATEGORIES[0], "Holiday & Seasonal > Christmas Trees > Pencil Christmas Tree")).toBe(true);
    expect(like(CHRISTMAS_CATEGORIES[0], "Home Furnishings > Holiday & Seasonal > Christmas Trees > Pre Lit")).toBe(true);
  });

  it("adds the code-owned seasonal line and hashtags, in each language", () => {
    expect(footer(plan({ moment: "early-bf" }), "fr")).toContain("Vendredi fou en avance");
    expect(footer(plan({ moment: "early-bf" }), "fr")).toContain("#vendredifou");
    expect(footer(plan({ moment: "early-bf" }), "en")).toContain("#blackfriday");
    expect(footer(plan({ moment: "cyber-monday" }), "fr")).toContain("#cyberlundi");
    expect(footer(plan({ moment: "cyber-monday" }), "en")).toContain("#cybermonday");
    expect(footer(plan({ moment: "noel" }), "fr")).toContain("#noel");
    expect(footer(plan({ moment: "noel" }), "en")).toContain("#christmas");
    expect(footer(plan(), "fr")).not.toMatch(/vendredi|#noel/i);
    for (const m of ["early-bf", "black-friday", "cyber-monday", "noel"] as const) {
      expect(footer(plan({ moment: m }), "fr")).not.toMatch(/\d|%|\$/); // never an amount or a promise
      expect(footer(plan({ moment: m }), "fr")).toContain("Livraison gratuite.");
    }
  });
});

describe("cooldown per Shopify product", () => {
  const cand = (sku: string, pid: string) => ({ sku, shopifyProductId: pid, nameEn: "Vanity", productType: "Dressing & Vanity Tables", stock: 5, velocity: 1 });
  const fields = (img: string) => ({ images: [img], titleFr: "Coiffeuse", lifestyle: { verified: true, primaryImageUrl: img }, handle: "coiffeuse", status: "active", price: "199.99", compareAtPrice: null });

  beforeEach(() => shopify.resolveProductFields.mockReset());

  it("treats another colour of a posted product as in cooldown", () => {
    const skip = new Set([productKey("7752237121641")]);
    expect(inCooldown(skip, { sku: "831-823V80WT", shopifyProductId: "7752237121641" })).toBe(true);
    expect(inCooldown(skip, { sku: "831-651V81WT", shopifyProductId: "7788349882473" })).toBe(false);
    expect(inCooldown(new Set(["831-823V80BK"]), { sku: "831-823V80BK", shopifyProductId: "" })).toBe(true);
  });

  it("verifyUntil skips a product in cooldown without calling Shopify, and never puts two colours of one product in a post", async () => {
    shopify.resolveProductFields.mockImplementation(async (id: string) => fields(`https://cdn.shopify.com/${id}-${Math.random()}.jpg`));
    const out = await verifyUntil(
      [cand("831-823V80BK", "100"), cand("831-823V80WT", "200"), cand("831-823V81WT", "200"), cand("839-846V80BK", "300")],
      3,
      new Set([productKey("100")]),
    );
    expect(out.map((p) => p.sku)).toEqual(["831-823V80WT", "839-846V80BK"]);
    expect(shopify.resolveProductFields).not.toHaveBeenCalledWith("100");
  });
});

describe("titles", () => {
  it("cuts the supplier title at the first clause and strips brands", () => {
    expect(shortEnglishTitle("HOMCOM Fold-out Convertible Office Desk, Wall Mount Computer Desk with Blackboard")).toBe("Fold-out Convertible Office Desk");
  });
});

describe("facts are written by code", () => {
  it("formats single product with price and link in each language", () => {
    expect(factsBlock(plan(), "fr")).toBe("Bureau mural rabattable 150 cm — 147,99 $\nVoir le produit: https://ameublodirect.ca/products/bureau-mural");
    expect(factsBlock(plan(), "en")).toContain("$147.99");
    expect(factsBlock(plan(), "en")).toContain("https://ameublodirect.ca/en/products/bureau-mural");
  });
  it("shows the rabais only when the product carries one", () => {
    const p = plan({ products: [product({ price: 75, compareAt: 100 })] });
    expect(factsBlock(p, "fr")).toContain("(avant 100,00 $, -25 %)");
    expect(factsBlock(plan(), "fr")).not.toContain("avant");
  });
  it("labels A/B and bullets multi-product posts", () => {
    const ab = plan({ format: "ab", products: [product({ handle: "a" }), product({ sku: "B", handle: "b", titleFr: "Autre" })], maxProducts: 2 });
    expect(factsBlock(ab, "fr")).toContain("A — Bureau");
    expect(factsBlock(ab, "fr")).toContain("B — Autre");
    expect(factsBlock(plan({ products: [product(), product({ sku: "B", handle: "b" })] }), "fr")).toContain("• ");
  });
  it("assembles body + facts + shipping + hashtags", () => {
    const out = assemble(plan(), "fr", "Un bureau qui disparaît?");
    expect(out.startsWith("Un bureau qui disparaît?")).toBe(true);
    expect(out).toContain("Livraison gratuite.");
    expect(out).toContain("#meubles");
    expect(formatPrice(5, "fr")).toBe("5,00 $");
  });
});

describe("validateBody", () => {
  const ok = "Ton coin télétravail mérite mieux que le comptoir de cuisine, non? Ce bureau se range dans le mur. Tu l'installerais où?";
  it("accepts a clean caption", () => expect(validateBody(ok, plan(), "fr").ok).toBe(true));
  it.each([
    ["a price", ok.replace("mur.", "mur à 99 $.")],
    ["a percent", ok.replace("mur.", "mur, -20 %.")],
    ["a link", `${ok} https://x.ca`],
    ["a hashtag", `${ok} #meuble`],
    ["a supplier", ok.replace("bureau", "bureau HOMCOM")],
    ["Aosom", ok.replace("bureau", "bureau Aosom")],
    ["fake urgency", ok.replace("Ce bureau", "Dernières unités! Ce bureau")],
    ["no question", ok.replace(/\?/g, ".")],
    ["an invented number", ok.replace("Ce bureau", "Ce bureau de 200 cm")],
  ])("rejects %s", (_n, text) => expect(validateBody(text, plan(), "fr").ok).toBe(false));
  it("lets a number through when it is in the product name", () => {
    expect(validateBody(ok.replace("Ce bureau", "Ce bureau de 150 cm"), plan(), "fr").ok).toBe(true);
  });
  it("requires A and B on the A/B format", () => {
    const ab = plan({ format: "ab", products: [product(), product({ sku: "B" })], maxProducts: 2 });
    expect(validateBody("Deux beaux bureaux pour ton coin travail, lequel te ressemble le plus? Dis-le nous.", ab, "fr").ok).toBe(false);
    expect(validateBody("Deux beaux bureaux pour ton coin travail, lequel te ressemble le plus? Réponds A ou B en commentaire.", ab, "fr").ok).toBe(true);
  });
  it("rejects English text on the French caption", () => {
    expect(validateBody("This is the desk that you are going to love for your home office and for the family, will you pick it?", plan(), "fr").ok).toBe(false);
  });
  it("tells the model what to avoid", () => {
    expect(bodyPrompt(plan(), "fr")).toContain("AUCUN prix");
    expect(bodyPrompt(plan(), "fr", "fausse urgence")).toContain("fausse urgence");
  });
});

describe("buildCaptions", () => {
  const good = "Ton coin télétravail mérite mieux que le comptoir, non? Ce bureau se range dans le mur. Tu l'installerais où?";
  const goodEn = "Your work corner deserves better than the kitchen counter, right? This desk folds into the wall. Where would you put it?";
  const gen = (script: Record<string, string[]>) => {
    const calls: Record<string, number> = {};
    return vi.fn(async (prompt: string) => {
      const kind = prompt.includes("fact-checker") ? "judge" : prompt.includes("Ameublo Direct") ? "fr" : "en";
      const i = (calls[kind] = (calls[kind] ?? 0) + 1) - 1;
      return script[kind][Math.min(i, script[kind].length - 1)];
    });
  };
  it("retries once after a rejected draft, then assembles both languages", async () => {
    const g = gen({ fr: ["Super prix à 99 $! Tu le veux?", good], en: [goodEn], judge: ['{"ok": true}'] });
    const r = await buildCaptions(plan(), g);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.captions.fr).toContain("147,99 $");
      expect(r.captions.en).toContain("$147.99");
    }
  });
  it("gives up (no post) when the judge keeps finding unsupported claims", async () => {
    const g = gen({ fr: [good], en: [goodEn], judge: ['{"ok": false, "issue": "garantie inventée"}'] });
    const r = await buildCaptions(plan(), g);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("garantie inventée");
  });
  it("fails closed on an unreadable judge verdict", async () => {
    const g = gen({ fr: [good], en: [goodEn], judge: ["peut-être"] });
    expect((await buildCaptions(plan(), g)).ok).toBe(false);
  });
});

describe("runSemaine", () => {
  const SCHEDULE = JSON.stringify({ enabled: true, timezone: "America/Toronto", max_per_day: 2, slots: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => ({ day, times: ["10:00", "15:00"] })) });
  const NOW = new Date("2026-10-12T12:00:00Z"); // Monday 08:00 Toronto
  const good = "Ton coin télétravail mérite mieux que le comptoir, non? Ce bureau se range dans le mur. Tu l'installerais où?";
  const goodEn = "Your work corner deserves better than the kitchen counter, right? This desk folds into the wall. Where would you put it?";
  let deps: RunDeps;
  let settings: Record<string, string | null>;

  beforeEach(() => {
    vi.clearAllMocks();
    settings = { semaine_enabled: "1", publication_schedule: SCHEDULE };
    let id = 100;
    db.addToQueue.mockImplementation(async () => ++id);
    vi.mocked(store.getPost).mockResolvedValue(null);
    deps = {
      getSetting: async (k) => settings[k] ?? null,
      picker: vi.fn(async (format) => plan({ format, products: [product()] })),
      gen: vi.fn(async (p: string) => (p.includes("fact-checker") ? '{"ok": true}' : p.includes("Ameublo Direct") ? good : goodEn)),
      recentSkus: async () => new Set<string>(),
      notify: vi.fn(async () => undefined),
    };
  });

  it("does nothing while the kill switch is off", async () => {
    settings.semaine_enabled = "0";
    const r = await runSemaine({ slot: "morning", now: NOW }, deps);
    expect(r).toMatchObject({ status: "skipped", reason: "disabled" });
    expect(db.addToQueue).not.toHaveBeenCalled();
    expect(store.savePost).not.toHaveBeenCalled();
  });

  it("queues one item per brand at the 10:00 Toronto slot, with the photos and the captions", async () => {
    const r = await runSemaine({ slot: "morning", now: NOW }, deps);
    expect(r.status).toBe("queued");
    expect(r.format).toBe("nouveautes"); // Monday
    expect(r.scheduledAt).toBe("2026-10-12 14:00:00"); // 10:00 EDT
    expect(db.addToQueue).toHaveBeenCalledTimes(2);
    const brands = db.addToQueue.mock.calls.map((c) => JSON.parse(c[0].payload).brand).sort();
    expect(brands).toEqual(["ameublo", "furnish"]);
    const fr = db.addToQueue.mock.calls.map((c) => c[0]).find((c) => JSON.parse(c.payload).brand === "ameublo");
    expect(JSON.parse(fr.payload).imageUrls).toEqual(["https://cdn.shopify.com/a.jpg"]);
    expect(JSON.parse(fr.payload).caption).toContain("147,99 $");
    expect(fr.contentType).toBe("social");
    expect(fr.metadata).toMatchObject({ source: "semaine", format: "nouveautes" });
    expect(store.savePost).toHaveBeenCalledWith(expect.objectContaining({ status: "queued", localDate: "2026-10-12", slot: "morning" }));
  });

  it("afternoon posts the featured product at 15:00", async () => {
    const r = await runSemaine({ slot: "afternoon", now: NOW }, deps);
    expect(r).toMatchObject({ status: "queued", format: "vedette", scheduledAt: "2026-10-12 19:00:00" });
  });

  it("never replaces an already queued slot", async () => {
    vi.mocked(store.getPost).mockResolvedValue({ local_date: "2026-10-12", slot: "morning", format: "nouveautes", status: "queued" });
    const r = await runSemaine({ slot: "morning", now: NOW }, deps);
    expect(r).toMatchObject({ status: "skipped", reason: "already_queued" });
    expect(db.addToQueue).not.toHaveBeenCalled();
  });

  it("falls back to another format when the planned one has too few verified products", async () => {
    deps.picker = vi.fn(async (format) => (format === "nouveautes" ? null : plan({ format })));
    const r = await runSemaine({ slot: "morning", now: NOW }, deps);
    expect(r.status).toBe("queued");
    expect(r.format).toBe("top-ventes");
  });

  it("skips and notifies when nothing can be built", async () => {
    deps.picker = vi.fn(async () => null);
    const r = await runSemaine({ slot: "morning", now: NOW }, deps);
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("aucun format prêt");
    expect(deps.notify).toHaveBeenCalled();
    expect(db.addToQueue).not.toHaveBeenCalled();
  });

  it("retries the same format with other products before changing format", async () => {
    let calls = 0;
    const seen: string[][] = [];
    deps.picker = vi.fn(async (format, ctx) => {
      seen.push([...ctx.skip]);
      return plan({ format, products: [product({ sku: `P${seen.length}` })] });
    });
    deps.gen = vi.fn(async (p: string) => {
      if (p.includes("fact-checker")) return calls++ < 4 ? '{"ok": false, "issue": "invented"}' : '{"ok": true}';
      return p.includes("Ameublo Direct") ? good : goodEn;
    });
    const r = await runSemaine({ slot: "morning", now: NOW }, deps);
    expect(r.format).toBe("nouveautes");
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual(["P1", "pid:1"]); // the rejected product (SKU + whole Shopify product) is excluded from the second pick
  });

  it("moves to the next format when a caption is rejected twice", async () => {
    let calls = 0;
    deps.picker = vi.fn(async (format) => plan({ format }));
    deps.gen = vi.fn(async (p: string) => {
      // FR and EN each get two attempts per pick, and each format gets two picks: reject all 8.
      if (p.includes("fact-checker")) return calls++ < 8 ? '{"ok": false, "issue": "invented"}' : '{"ok": true}';
      return p.includes("Ameublo Direct") ? good : goodEn;
    });
    const r = await runSemaine({ slot: "morning", now: NOW }, deps);
    expect(r.status).toBe("queued");
    expect(r.format).not.toBe("nouveautes");
  });

  it("undoes the first brand when the slot is taken for the second", async () => {
    let n = 0;
    db.addToQueue.mockImplementation(async () => {
      if (++n === 2) throw new db.QueueSlotTakenError("slot");
      return 101;
    });
    const r = await runSemaine({ slot: "morning", now: NOW }, deps);
    expect(r.status).toBe("skipped");
    expect(db.cancelPendingQueueItems).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalled();
  });

  it("skips when the slot already passed", async () => {
    const r = await runSemaine({ slot: "morning", now: new Date("2026-10-12T15:00:00Z") }, deps); // 11:00 Toronto
    expect(r.status).toBe("skipped");
    expect(db.addToQueue).not.toHaveBeenCalled();
  });

  it("during the early Black Friday sale the morning post is baisses and carries the seasonal footer", async () => {
    const r = await runSemaine({ slot: "morning", now: new Date("2026-11-09T12:00:00Z") }, deps); // Monday 07:00 Toronto
    expect(r).toMatchObject({ status: "queued", format: "baisses" });
    expect(r.captions?.fr).toContain("#vendredifou");
    expect(r.captions?.en).toContain("#blackfriday");
  });

  it("a rejected caption puts the whole product (every colour) out of the retry pick", async () => {
    const seen: string[][] = [];
    let calls = 0;
    deps.picker = vi.fn(async (format, ctx) => {
      seen.push([...ctx.skip]);
      return plan({ format, products: [product({ sku: "831-823V80BK", shopifyProductId: "7752237121641" })] });
    });
    deps.gen = vi.fn(async (p: string) => {
      if (p.includes("fact-checker")) return calls++ < 4 ? '{"ok": false, "issue": "invented"}' : '{"ok": true}';
      return p.includes("Ameublo Direct") ? good : goodEn;
    });
    await runSemaine({ slot: "morning", now: NOW }, deps);
    expect(seen[1]).toEqual(expect.arrayContaining(["831-823V80BK", productKey("7752237121641")]));
  });

  it("dry run builds everything, queues and saves nothing, and ignores the kill switch", async () => {
    settings.semaine_enabled = "0";
    const r = await runSemaine({ slot: "morning", now: NOW, dryRun: true }, deps);
    expect(r.status).toBe("dry_run");
    expect(r.captions?.fr).toContain("147,99 $");
    expect(db.addToQueue).not.toHaveBeenCalled();
    expect(store.savePost).not.toHaveBeenCalled();
  });
});
