import { describe, it, expect, vi } from "vitest";
import {
  collectMorningReport,
  localClock,
  previousDay,
  renderMorningReport,
  type MorningReportSources,
} from "@/lib/morning-report";

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
    guides: vi.fn(async () => ({ pending: 5, ready: 3, attention: 2, attentionTitles: ["Guide A", "Guide B"] })),
    videos: vi.fn(async () => ({ pendingApproval: 4, scheduledSoon: 6, horizonDays: 3 })),
    alerts: vi.fn(async () => [
      { label: "Prix sous le plancher", count: 1 },
      { label: "Images à revoir", count: 0 },
    ]),
    blocked: vi.fn(async () => [
      { label: "Publicités séquentielles à approuver", count: 16 },
      { label: "Imports en attente", count: 0 },
    ]),
    ...over,
  };
}

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
