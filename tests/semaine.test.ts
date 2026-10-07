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

import { localDay, plannedFormat, MORNING_FORMAT } from "@/lib/semaine/formats";
import { shortEnglishTitle } from "@/lib/semaine/live";
import { validateBody, factsBlock, assemble, buildCaptions, formatPrice, bodyPrompt } from "@/lib/semaine/caption";
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

describe("titles", () => {
  it("cuts the supplier title at the first clause and strips brands", () => {
    expect(shortEnglishTitle("HOMCOM Fold-out Convertible Office Desk, Wall Mount Computer Desk with Blackboard")).toBe("Fold-out Convertible Office Desk");
  });
});

describe("facts are written by code", () => {
  it("formats single product with price and link in each language", () => {
    expect(factsBlock(plan(), "fr")).toBe("Bureau mural rabattable 150 cm — 147,99 $\nVoir le produit: https://ameublodirect.ca/products/bureau-mural");
    expect(factsBlock(plan(), "en")).toContain("$147.99");
    expect(factsBlock(plan(), "en")).toContain("https://furnishdirect.ca/products/bureau-mural");
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
    expect(seen[1]).toEqual(["P1"]); // the rejected product is excluded from the second pick
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

  it("dry run builds everything, queues and saves nothing, and ignores the kill switch", async () => {
    settings.semaine_enabled = "0";
    const r = await runSemaine({ slot: "morning", now: NOW, dryRun: true }, deps);
    expect(r.status).toBe("dry_run");
    expect(r.captions?.fr).toContain("147,99 $");
    expect(db.addToQueue).not.toHaveBeenCalled();
    expect(store.savePost).not.toHaveBeenCalled();
  });
});
