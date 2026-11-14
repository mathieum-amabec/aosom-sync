import { describe, it, expect, vi } from "vitest";
import {
  collectMorningReport,
  localClock,
  previousDay,
  renderMorningReport,
  reelsRunwayDays,
  type MorningReportSources,
} from "@/lib/morning-report";
import type { GuardStatus } from "@/lib/guard-status";
import type { ShopSummary } from "@/lib/shop-analytics";

const SHOP: ShopSummary = {
  day: "2026-10-04",
  weekStart: "2026-09-28",
  dayFunnel: { sessions: 668, carts: 20, checkouts: 10, bought: 3, conversion: 3 / 668 },
  daySales: { orders: 3, total: 592.09, aov: 592.09 / 3 },
  weekFunnel: { sessions: 4300, carts: 150, checkouts: 90, bought: 13, conversion: 13 / 4300 },
  weekSales: { orders: 13, total: 2400, aov: 2400 / 13 },
  prevWeekFunnel: { sessions: 3800, carts: 120, checkouts: 70, bought: 15, conversion: 15 / 3800 },
  prevWeekSales: { orders: 15, total: 2900, aov: 2900 / 15 },
  sources: [
    { name: "réseaux sociaux", sessions: 3200, bought: 7, conversion: 7 / 3200 },
    { name: "recherche", sessions: 300, bought: 3, conversion: 0.01 },
  ],
  dayOrderSources: [
    { label: "Meta (pub)", orders: 1, total: 202.35 },
    { label: "Recherche (Google, Bing…)", orders: 1, total: 229.94 },
  ],
  meta: { spend: 600, orders: 5, maybeOrders: 1, costPerOrder: 120, costPerOrderLow: 100 },
};

const campaign = {
  id: "1",
  name: "Advantage+ Sales",
  dailyBudget: 14000,
  spend: 131.4,
  impressions: 9120,
  linkClicks: 402,
  purchases: 2,
  purchaseValue: 318.5,
  learning: ["LEARNING"],
};

function sources(over: Partial<MorningReportSources> = {}): MorningReportSources {
  return {
    meta: vi.fn(async () => [campaign]),
    shop: vi.fn(async () => SHOP),
    guides: vi.fn(async () => ({ pending: 5, ready: 3, attention: 2, attentionTitles: ["Guide A", "Guide B"] })),
    videos: vi.fn(async () => ({ pendingApproval: 4, scheduledSoon: 6, horizonDays: 3 })),
    reelsStock: vi.fn(async () => ({
      fr: { scheduled: 24, lastScheduledAt: "2026-10-05 23:45:00", ready: 30 },
      en: { scheduled: 24, lastScheduledAt: "2026-10-05 23:50:00", ready: 28 },
    })),
    reelResults: vi.fn(async () => ({ days: 7, measured: 40, totalPlays: 812, avgWatchS: 4.2, bestStyle: { key: "vitrine", avgPlays: 31.5, n: 9 }, lastMeasuredOn: "2026-10-12" })),
    photoResults: vi.fn(async () => ({ days: 7, measured: 14, totalViews: 5230, totalReactions: 88, totalComments: 12, totalShares: 3, instagramViews: 1900, bestFormat: { key: "baisses", avgViews: 612.5, n: 6 }, lastMeasuredOn: "2026-10-12" })),
    alerts: vi.fn(async () => [
      { label: "Prix sous le plancher", count: 1 },
      { label: "Images à revoir", count: 0 },
    ]),
    blocked: vi.fn(async () => [
      { label: "Publicités séquentielles à approuver", count: 16 },
      { label: "Imports en attente", count: 0 },
    ]),
    guards: vi.fn(async () => GREEN_GUARDS),
    ...over,
  };
}

const guard = (key: GuardStatus["key"], label: string, over: Partial<GuardStatus> = {}): GuardStatus => ({
  key, label, state: "green", summary: "ok", reasons: [], checkedAt: 1, ...over,
});
const GREEN_GUARDS: GuardStatus[] = [
  guard("price", "Prix plancher"),
  guard("catalog", "Cohérence du catalogue"),
  guard("images", "Conformité des images"),
  guard("feed", "Flux publicitaires"),
];

describe("localClock / previousDay", () => {
  it("maps 10:00 UTC to 06:00 in Montreal during daylight time (EDT, UTC-4)", () => {
    expect(localClock(new Date("2026-09-25T10:00:00Z"))).toEqual({ date: "2026-09-25", hour: 6 });
    expect(localClock(new Date("2026-09-25T11:00:00Z")).hour).toBe(7);
  });

  it("maps 11:00 UTC to 06:00 in Montreal during standard time (EST, UTC-5)", () => {
    expect(localClock(new Date("2026-12-15T11:00:00Z"))).toEqual({ date: "2026-12-15", hour: 6 });
    expect(localClock(new Date("2026-12-15T10:00:00Z")).hour).toBe(5);
  });

  it("uses the Montreal calendar date, not the UTC one", () => {
    // 03:30 UTC on the 26th is still the 25th in Montreal.
    expect(localClock(new Date("2026-09-26T03:30:00Z")).date).toBe("2026-09-25");
  });

  it("steps back one calendar day across month and year boundaries", () => {
    expect(previousDay("2026-10-01")).toBe("2026-09-30");
    expect(previousDay("2027-01-01")).toBe("2026-12-31");
  });
});

describe("collectMorningReport", () => {
  it("asks Meta for yesterday's figures (Montreal date - 1)", async () => {
    const s = sources();
    const data = await collectMorningReport(s, new Date("2026-09-25T10:00:00Z"));
    expect(data.reportDate).toBe("2026-09-25");
    expect(data.metaDay).toBe("2026-09-24");
    expect(s.meta).toHaveBeenCalledWith("2026-09-24");
  });

  it("isolates a failing source: the other sections are still collected", async () => {
    const data = await collectMorningReport(
      sources({ meta: vi.fn(async () => { throw new Error("Meta Ads API: Service temporarily unavailable"); }) }),
      new Date("2026-09-25T10:00:00Z"),
    );
    expect(data.meta).toEqual({ ok: false, error: "Meta Ads API: Service temporarily unavailable" });
    expect(data.guides.ok).toBe(true);
    expect(data.videos.ok).toBe(true);
    expect(data.alerts.ok).toBe(true);
    expect(data.blocked.ok).toBe(true);
  });
});

describe("renderMorningReport", () => {
  it("renders every section with the real figures", async () => {
    const r = renderMorningReport(await collectMorningReport(sources(), new Date("2026-09-25T10:00:00Z")));
    expect(r.subject).toBe("Rapport du matin — vendredi 25 septembre");
    expect(r.missingSections).toEqual([]);
    expect(r.text).toContain("Advantage+ Sales");
    expect(r.text).toMatch(/9\s120 impressions/); // fr-CA groups with a narrow no-break space
    expect(r.text).toContain("2 achats");
    expect(r.text).toContain("en apprentissage");
    expect(r.text).toContain("5 guides en attente : 3 prêts, 2 à vérifier.");
    expect(r.text).toContain("À vérifier : Guide A · Guide B");
    expect(r.text).toContain("4 vidéos en attente d'approbation.");
    expect(r.text).toContain("6 vidéos planifiées dans les 3 prochains jours.");
    expect(r.text).toContain("Prix sous le plancher : 1");
    expect(r.text).not.toContain("Images à revoir"); // zero-count alerts are omitted
    expect(r.text).toContain("Publicités séquentielles à approuver : 16");
    expect(r.text).not.toContain("Imports en attente");
    expect(r.html).toContain("<h2");
  });

  it("says 'Rien à signaler.' when no alert is active", async () => {
    const r = renderMorningReport(
      await collectMorningReport(
        sources({ alerts: vi.fn(async () => [{ label: "Prix sous le plancher", count: 0 }]) }),
        new Date("2026-09-25T10:00:00Z"),
      ),
    );
    expect(r.text).toContain("Rien à signaler.");
  });

  it("flags an unavailable section in the body AND the subject instead of dropping it", async () => {
    const r = renderMorningReport(
      await collectMorningReport(
        sources({ meta: vi.fn(async () => { throw new Error("Meta down"); }) }),
        new Date("2026-09-25T10:00:00Z"),
      ),
    );
    expect(r.subject).toContain("(1 section indisponible)");
    expect(r.missingSections).toEqual(["Publicités Meta — jeudi 24 septembre"]);
    expect(r.text).toContain("⚠ Section indisponible (Meta down)");
    expect(r.html).toContain("Section indisponible");
    // The rest still renders.
    expect(r.text).toContain("5 guides en attente");
  });

  it("escapes HTML coming from data (campaign or guide names)", async () => {
    const r = renderMorningReport(
      await collectMorningReport(
        sources({ meta: vi.fn(async () => [{ ...campaign, name: "<script>x</script>" }]) }),
        new Date("2026-09-25T10:00:00Z"),
      ),
    );
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
  });
});

describe("renderMorningReport — guards section", () => {
  const at = new Date("2026-09-25T10:00:00Z");

  it("all green: one reassuring line, subject unchanged", async () => {
    const r = renderMorningReport(await collectMorningReport(sources(), at));
    expect(r.subject).toBe("Rapport du matin — vendredi 25 septembre");
    expect(r.text).toContain(
      "✅ Tous les garde-fous sont au vert (prix plancher, cohérence du catalogue, conformité des images, flux publicitaires).",
    );
    expect(r.text).not.toContain("🔴");
  });

  it("red guards: listed first with their reasons, counted in the subject, heading in red", async () => {
    const guards = [
      guard("price", "Prix plancher"),
      guard("catalog", "Cohérence du catalogue", { state: "red", reasons: ["5 fiches avec couleur en double"] }),
      guard("images", "Conformité des images"),
      guard("feed", "Flux publicitaires", { state: "red", reasons: ["le flux Google publié n'a plus aucun lien ?variant="] }),
    ];
    const r = renderMorningReport(await collectMorningReport(sources({ guards: vi.fn(async () => guards) }), at));
    expect(r.subject).toBe("🔴 2 garde-fous en alerte — Rapport du matin — vendredi 25 septembre");
    // The guards section comes before every other section.
    expect(r.text.indexOf("GARDE-FOUS — 2 ALERTES")).toBeGreaterThan(-1);
    expect(r.text.indexOf("GARDE-FOUS")).toBeLessThan(r.text.indexOf("PUBLICITÉS META"));
    expect(r.text).toContain("🔴 Cohérence du catalogue : 5 fiches avec couleur en double");
    expect(r.text).toContain("🔴 Flux publicitaires : le flux Google publié n'a plus aucun lien ?variant=");
    expect(r.text).toContain("Au vert : prix plancher, conformité des images.");
    expect(r.html).toContain("color:#b91c1c");
  });

  it("a single red guard uses the singular in the subject", async () => {
    const guards = [guard("images", "Conformité des images", { state: "red", reasons: ["1 image attend ta décision"] })];
    const r = renderMorningReport(await collectMorningReport(sources({ guards: vi.fn(async () => guards) }), at));
    expect(r.subject.startsWith("🔴 1 garde-fou en alerte — ")).toBe(true);
  });

  it("a guard that never ran is reported as 'pas encore de résultat', not as an alert", async () => {
    const guards = [...GREEN_GUARDS.slice(0, 3), guard("feed", "Flux publicitaires", { state: "unknown", checkedAt: null })];
    const r = renderMorningReport(await collectMorningReport(sources({ guards: vi.fn(async () => guards) }), at));
    expect(r.subject).not.toContain("🔴");
    expect(r.text).toContain("Pas encore de résultat : flux publicitaires.");
  });

  it("a guard-status read failure is an unavailable section, and the email still goes out", async () => {
    const r = renderMorningReport(
      await collectMorningReport(sources({ guards: vi.fn(async () => { throw new Error("Turso down"); }) }), at),
    );
    expect(r.missingSections).toContain("Garde-fous");
    expect(r.text).toContain("⚠ Section indisponible (Turso down)");
    expect(r.text).toContain("5 guides en attente");
  });
});

describe("reelsRunwayDays", () => {
  it("counts the days of approved Reels from today to the last scheduled day, inclusive (Montreal dates)", () => {
    expect(reelsRunwayDays("2026-10-16 23:45:00", "2026-10-05")).toBe(12); // Oct 5 → Oct 16
    expect(reelsRunwayDays("2026-10-05 23:45:00", "2026-10-05")).toBe(1); // only today left
    expect(reelsRunwayDays("2026-10-06 02:00:00", "2026-10-05")).toBe(1); // 22:00 Montreal on the 5th, not the 6th
  });
  it("is 0 when nothing is scheduled or everything is already past", () => {
    expect(reelsRunwayDays(null, "2026-10-05")).toBe(0);
    expect(reelsRunwayDays("2026-10-01 12:00:00", "2026-10-05")).toBe(0);
  });
});

describe("Studio Reels reserve section", () => {
  const NOW = new Date("2026-10-05T10:00:00Z"); // 06:00 Montreal, Oct 5

  it("raises the alert and flags the subject when a page has under 7 days of approved Reels", async () => {
    const r = renderMorningReport(await collectMorningReport(sources(), NOW)); // both pages: only today left
    expect(r.text).toContain("RÉSERVE DE REELS (STUDIO) — BASSE");
    expect(r.text).toContain("🔴 Ameublo (FR) : 1 jour de vidéos planifiées (24 vidéos) · 30 prêtes à approuver.");
    expect(r.text).toContain("Plan de la semaine");
    expect(r.subject).toContain("🟠 réserve de Reels basse");
    expect(r.html).toContain("color:#b91c1c");
  });

  it("stays quiet when both pages have a week or more ahead", async () => {
    const r = renderMorningReport(
      await collectMorningReport(
        sources({ reelsStock: vi.fn(async () => ({ fr: { scheduled: 21, lastScheduledAt: "2026-10-14 23:45:00", ready: 5 }, en: { scheduled: 21, lastScheduledAt: "2026-10-14 23:50:00", ready: 5 } })) }),
        NOW,
      ),
    );
    expect(r.text).toContain("RÉSERVE DE REELS (STUDIO)");
    expect(r.text).not.toContain("BASSE");
    expect(r.text).toContain("Ameublo (FR) : 10 jours de vidéos planifiées (21 vidéos)");
    expect(r.subject).not.toContain("réserve");
  });

  it("says so when a page has nothing scheduled at all", async () => {
    const r = renderMorningReport(
      await collectMorningReport(sources({ reelsStock: vi.fn(async () => ({ fr: { scheduled: 0, lastScheduledAt: null, ready: 0 }, en: { scheduled: 3, lastScheduledAt: "2026-10-05 23:50:00", ready: 2 } })) }), NOW),
    );
    expect(r.text).toContain("🔴 Ameublo (FR) : plus aucune vidéo planifiée · 0 prête à approuver.");
  });

  it("a failing source only marks this section unavailable", async () => {
    const data = await collectMorningReport(sources({ reelsStock: vi.fn(async () => { throw new Error("db down"); }) }), NOW);
    expect(data.reelsStock).toEqual({ ok: false, error: "db down" });
    expect(data.videos.ok).toBe(true);
    expect(renderMorningReport(data).missingSections).toEqual(["Réserve de Reels (Studio)"]);
  });
});

describe("Photo results section", () => {
  const NOW = new Date("2026-10-12T10:00:00Z");
  const results = (over: object) =>
    sources({ photoResults: vi.fn(async () => ({ days: 7, measured: 14, totalViews: 5230, totalReactions: 88, totalComments: 12, totalShares: 3, instagramViews: null, bestFormat: null, lastMeasuredOn: "2026-10-12", ...over })) });

  it("shows the totals, Instagram and the best format by its French name", async () => {
    const r = renderMorningReport(await collectMorningReport(sources(), NOW));
    expect(r.text).toContain("RÉSULTATS DES PHOTOS (FACEBOOK) — 7 J");
    expect(r.text).toMatch(/14 photos mesurées sur 7 jours · 5\s?230 vues · 88 réactions, 12 commentaires, 3 partages · Instagram : 1\s?900 vues\./);
    expect(r.text).toContain("Format le plus vu : Prix en baisse (612,5 vues en moyenne, 6 photos).");
  });
  it("says it is too early to compare when no format has enough photos", async () => {
    const r = renderMorningReport(await collectMorningReport(results({ bestFormat: null }), NOW));
    expect(r.text).toContain("Trop tôt pour comparer les formats");
    expect(r.text).not.toContain("Format le plus vu");
  });
  it("omits Instagram when none was measured", async () => {
    const r = renderMorningReport(await collectMorningReport(results({}), NOW));
    expect(r.text).not.toContain("Instagram :");
  });
  it("says collection has just started when nothing was measured", async () => {
    const r = renderMorningReport(await collectMorningReport(results({ measured: 0, totalViews: 0 }), NOW));
    expect(r.text).toContain("Aucune photo mesurée pour l'instant");
  });
  it("a failing source only marks this section unavailable", async () => {
    const data = await collectMorningReport(sources({ photoResults: vi.fn(async () => { throw new Error("graph down"); }) }), NOW);
    expect(data.photoResults).toEqual({ ok: false, error: "graph down" });
    expect(renderMorningReport(data).missingSections).toEqual(["Résultats des photos (Facebook)"]);
  });
});

describe("Reel results section", () => {
  const NOW = new Date("2026-10-12T10:00:00Z");
  const results = (over: object) =>
    sources({ reelResults: vi.fn(async () => ({ days: 7, measured: 12, totalPlays: 240, avgWatchS: 4.2, bestStyle: null, lastMeasuredOn: "2026-10-12", ...over })) });

  it("shows the totals and the best kind of video by its French name", async () => {
    const r = renderMorningReport(await collectMorningReport(sources(), NOW));
    expect(r.text).toContain("RÉSULTATS DES REELS (FACEBOOK) — 7 J");
    expect(r.text).toMatch(/40 Reels mesurés sur 7 jours · 812 lectures au total · 4,2 s regardées en moyenne\./);
    expect(r.text).toContain("Type le plus regardé : Vitrine (31,5 lectures en moyenne, 9 Reels).");
  });
  it("says it is too early to compare when no kind of video has enough Reels", async () => {
    const r = renderMorningReport(await collectMorningReport(results({ bestStyle: null }), NOW));
    expect(r.text).toContain("Trop tôt pour comparer les types de vidéos (il faut au moins 5 Reels par type).");
    expect(r.text).not.toContain("Type le plus regardé");
  });
  it("says collection has just started when nothing was measured", async () => {
    const r = renderMorningReport(await collectMorningReport(results({ measured: 0, totalPlays: 0, avgWatchS: null }), NOW));
    expect(r.text).toContain("Aucun Reel mesuré pour l'instant");
  });
  it("names the new Hormozi styles properly instead of their raw key", async () => {
    const r = renderMorningReport(await collectMorningReport(results({ bestStyle: { key: "aventure", avgPlays: 10, n: 6 } }), NOW));
    expect(r.text).toContain("Les aventures d’Ameublo");
  });
  it("a failing source only marks this section unavailable", async () => {
    const data = await collectMorningReport(sources({ reelResults: vi.fn(async () => { throw new Error("graph down"); }) }), NOW);
    expect(data.reelResults).toEqual({ ok: false, error: "graph down" });
    expect(renderMorningReport(data).missingSections).toEqual(["Résultats des Reels (Facebook)"]);
  });
});

describe("Boutique (Shopify) section", () => {
  const NOW = new Date("2026-10-05T10:00:00Z");
  const text = async (shop?: MorningReportSources["shop"]) =>
    renderMorningReport(await collectMorningReport(sources(shop ? { shop } : {}), NOW)).text;

  it("asks the shop source for the same day as the Meta figures", async () => {
    const shop = vi.fn(async () => SHOP);
    await collectMorningReport(sources({ shop }), NOW);
    expect((shop.mock.calls as unknown[][])[0]).toEqual(["2026-10-04"]);
  });

  it("shows yesterday's sales, where the orders came from, the funnel, the week vs the previous one and the sources", async () => {
    const t = await text();
    expect(t).toContain("BOUTIQUE (SHOPIFY)");
    expect(t).toMatch(/Hier : 3 commandes/);
    expect(t).toContain("Meta (pub) 1");
    expect(t).toContain("Recherche (Google, Bing…) 1");
    expect(t).toMatch(/Visites hier : 668/);
    expect(t).toMatch(/4\s?300 visites \(\+13 %\)/); // 4300 vs 3800
    expect(t).toMatch(/13 commandes \(−13 %\)/); // 13 vs 15
    expect(t).toMatch(/90 arrivent au paiement → 13 achètent/);
    expect(t).toMatch(/réseaux sociaux 3\s?200/);
    expect(t).toMatch(/dernier clic, indicatif/);
    expect(t).toMatch(/120,00.* par commande/);
    expect(t).toMatch(/100,00.* si on compte aussi les 1 venues de Facebook/); // range, not a single exact figure
  });

  it("comes before the Meta section", async () => {
    const t = await text();
    expect(t.indexOf("BOUTIQUE (SHOPIFY)")).toBeGreaterThan(-1);
    expect(t.indexOf("BOUTIQUE (SHOPIFY)")).toBeLessThan(t.indexOf("PUBLICITÉS META"));
  });

  it("says 0 commande on a day without orders and omits the origin line", async () => {
    const t = await text(vi.fn(async () => ({ ...SHOP, daySales: { orders: 0, total: 0, aov: null }, dayOrderSources: [] })));
    expect(t).toContain("Hier : 0 commande.");
    expect(t).not.toContain("Provenance des commandes");
  });

  it("does not claim a % change when the previous week has no base", async () => {
    const t = await text(vi.fn(async () => ({ ...SHOP, prevWeekFunnel: { ...SHOP.prevWeekFunnel, sessions: 0 }, prevWeekSales: { orders: 0, total: 0, aov: null } })));
    expect(t).not.toMatch(/visites \([+−±]/);
  });

  it("reports the Meta line as unavailable without hiding the rest", async () => {
    const t = await text(vi.fn(async () => ({ ...SHOP, meta: { error: "graph down" } })));
    expect(t).toContain("Pub Meta vs ventes : indisponible (graph down)");
    expect(t).toMatch(/Hier : 3 commandes/);
  });

  it("does not read as « ads do not work » when the only Facebook orders carry no ad tag", async () => {
    const t = await text(vi.fn(async () => ({ ...SHOP, meta: { spend: 80, orders: 0, maybeOrders: 2, costPerOrder: null, costPerOrderLow: 40 } })));
    expect(t).toContain("aucune commande avec une pub identifiée");
    expect(t).toMatch(/2 commandes venues de Facebook\/Instagram sans pub identifiée/);
  });

  it("says no order is linked to Facebook/Instagram when there is none at all", async () => {
    const t = await text(vi.fn(async () => ({ ...SHOP, meta: { spend: 80, orders: 0, maybeOrders: 0, costPerOrder: null, costPerOrderLow: null } })));
    expect(t).toContain("aucune commande reliée à Facebook/Instagram");
  });

  it("marks the section unavailable when Shopify analytics fails, still sending the rest", async () => {
    const data = await collectMorningReport(sources({ shop: vi.fn(async () => { throw new Error("ACCESS_DENIED"); }) }), NOW);
    expect(data.shop).toEqual({ ok: false, error: "ACCESS_DENIED" });
    const r = renderMorningReport(data);
    expect(r.missingSections.some((s) => s.startsWith("Boutique (Shopify)"))).toBe(true);
    expect(r.text).toContain("PUBLICITÉS META");
  });
});
