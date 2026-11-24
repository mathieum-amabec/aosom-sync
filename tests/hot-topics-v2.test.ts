import { describe, it, expect } from "vitest";
import { mtlGamesToFacts, type NhlGame } from "@/lib/hot-topics/nhl";
import { blackFridayDay, buildAllEntries, calendarPosts, CALENDAR_IDS, nthWeekday } from "@/lib/hot-topics/calendar";
import { checkPostText } from "@/lib/hot-topics/generator";
import { hotTopicBlockReason } from "@/lib/hot-topics/guard";
import { draftToQueueItems } from "@/lib/social-publisher";
import type { FacebookDraft } from "@/lib/database";

const NOW = new Date("2026-11-22T14:00:00Z"); // Sunday morning, the day after a home game

function game(over: Partial<NhlGame> & { mtlHome?: boolean; mtl?: number; opp?: number }): NhlGame {
  const { mtlHome = true, mtl = 3, opp = 4, ...rest } = over;
  const mtlTeam = { commonName: { default: "Canadiens" }, placeName: { default: "Montréal" }, abbrev: "MTL" };
  const flyers = {
    commonName: { default: "Flyers" }, placeName: { default: "Philadelphia", fr: "Philadelphie" },
    placeNameWithPreposition: { default: "Philadelphia", fr: "de Philadelphie" }, abbrev: "PHI",
  };
  return {
    gameType: 2, gameState: "OFF", gameDate: "2026-11-21", startTimeUTC: "2026-11-22T00:00:00Z",
    gameCenterLink: "/gamecenter/phi-vs-mtl/2026/11/21/2026020365",
    homeTeam: mtlHome ? { ...mtlTeam, score: mtl } : { ...flyers, score: opp },
    awayTeam: mtlHome ? { ...flyers, score: opp } : { ...mtlTeam, score: mtl },
    periodDescriptor: { periodType: "REG" },
    ...rest,
  };
}

describe("NHL facts", () => {
  it("states the last Canadiens game as a hard fact, by team name only", () => {
    const [last] = mtlGamesToFacts([game({})], NOW);
    expect(last).toMatchObject({
      kind: "fact", source: "nhl-api",
      title: "Le Canadien a perdu 3-4 contre les Flyers de Philadelphie samedi soir",
      url: "https://www.nhl.com/gamecenter/phi-vs-mtl/2026/11/21/2026020365",
    });
    expect(last.context?.join(" ")).toContain("Pointage final: Canadiens 3");
    expect(last.published).toBeGreaterThan(Date.parse("2026-11-22T00:00:00Z") / 1000);
  });
  it("reads a win on the road, and says so after overtime / shootout", () => {
    const [w] = mtlGamesToFacts([game({ mtlHome: false, mtl: 5, opp: 2 })], NOW);
    expect(w.title).toBe("Le Canadien a gagné 5-2 contre les Flyers de Philadelphie samedi soir");
    const [ot] = mtlGamesToFacts([game({ periodDescriptor: { periodType: "OT" } })], NOW);
    expect(ot.title).toMatch(/ en prolongation$/);
    const [so] = mtlGamesToFacts([game({ periodDescriptor: { periodType: "SO" } })], NOW);
    expect(so.title).toMatch(/ en tirs de barrage$/);
  });
  it("ignores a game older than 36 h, unfinished games and preseason", () => {
    expect(mtlGamesToFacts([game({ startTimeUTC: "2026-11-19T00:00:00Z" })], NOW)).toEqual([]);
    expect(mtlGamesToFacts([game({ gameState: "LIVE" })], NOW)).toEqual([]);
    expect(mtlGamesToFacts([game({ gameType: 1 })], NOW)).toEqual([]);
  });
  it("announces the next game when it is within 30 h, expiring at puck drop", () => {
    const next = game({ gameState: "FUT", startTimeUTC: "2026-11-23T00:30:00Z", mtlHome: true });
    const facts = mtlGamesToFacts([game({}), next], NOW);
    const upcoming = facts.find((f) => /affronte/.test(f.title));
    expect(upcoming?.title).toBe("Le Canadien affronte les Flyers de Philadelphie ce soir");
    expect(upcoming?.expires).toBe(Date.parse("2026-11-23T00:30:00Z") / 1000);
    expect(mtlGamesToFacts([game({ gameState: "FUT", startTimeUTC: "2026-11-27T00:30:00Z" })], NOW)).toEqual([]);
  });
});

describe("calendar bank", () => {
  it("computes the floating holidays", () => {
    expect(blackFridayDay(2026)).toBe(27);
    expect(nthWeekday(2027, 3, 0, 2)).toBe(14); // 2e dimanche de mars 2027
    expect(nthWeekday(2027, 5, 0, 2)).toBe(9); // fête des mères 2027
    expect(nthWeekday(2026, 11, 0, 1)).toBe(1); // 1er dimanche de novembre 2026
  });

  it("every entry passes the SAME validator as the LLM posts — every day of its window, several years", () => {
    for (const year of [2026, 2027, 2028, 2029, 2030]) {
      for (const days of [-3, -1, 0, 1, 2, 5, 9, 14, 30, 31]) {
        for (const e of buildAllEntries(year, days)) {
          expect(checkPostText(e), `${e.id} ${year} days=${days}`).toBeNull();
          expect(`${e.factLine} ${e.question} ${e.caption}`).not.toMatch(/undefined|NaN|\{|\}/);
        }
      }
    }
    expect(new Set(CALENDAR_IDS).size).toBe(CALENDAR_IDS.length);
  });

  it("every post produced on every day of a full year is valid", () => {
    const start = Date.parse("2026-11-24T15:00:00Z");
    for (let d = 0; d < 400; d++) {
      for (const p of calendarPosts(new Date(start + d * 86400_000))) {
        expect(checkPostText(p), `${p.id} +${d}d`).toBeNull();
        expect(p.expiresAt).toBeGreaterThan(Math.floor((start + d * 86400_000) / 1000) - 5 * 3600 - 86400 * 4);
      }
    }
  });

  it("surfaces the right posts around the dates that matter, nearest date first", () => {
    const ids = (iso: string) => calendarPosts(new Date(iso)).map((p) => p.id);
    // Tue 24 Nov 2026: Vendredi fou in 3 days, pneus d'hiver in 7, Noël in 31.
    expect(ids("2026-11-24T15:00:00Z")).toEqual(["vendredi-fou", "pneus-hiver", "sapin-noel"]);
    const pneus = calendarPosts(new Date("2026-11-24T15:00:00Z")).find((p) => p.id === "pneus-hiver")!;
    expect(pneus.factLine).toBe("Les pneus d'hiver sont obligatoires au Québec dès le 1er décembre, dans 7 jours.");
    expect(pneus.days).toBe(7);
    expect(ids("2026-12-01T15:00:00Z")).toContain("pneus-hiver");
    expect(calendarPosts(new Date("2026-12-01T15:00:00Z")).find((p) => p.id === "pneus-hiver")!.factLine).toMatch(/depuis le 1er décembre/);
    expect(ids("2026-12-10T15:00:00Z")).not.toContain("pneus-hiver");
    expect(ids("2026-09-15T15:00:00Z")).toEqual([]);
    expect(ids("2027-06-05T15:00:00Z")).toContain("demenagement");
  });

  it("expires a countdown after its last day", () => {
    const p = calendarPosts(new Date("2026-11-24T15:00:00Z")).find((x) => x.id === "pneus-hiver")!;
    // Dec 1 + 3 days after → end of Dec 4 (Toronto), never later.
    expect(p.expiresAt).toBe(Date.UTC(2026, 11, 5) / 1000 + 5 * 3600);
  });
});

describe("publish-time guard", () => {
  const nowSec = Math.floor(NOW.getTime() / 1000);
  it("lets a fresh, clean post through", () => {
    expect(hotTopicBlockReason({ caption: "Pelle ou patience?", expiresAt: nowSec + 3600, nowSec })).toBeNull();
    expect(hotTopicBlockReason({ caption: "Pelle ou patience?", nowSec })).toBeNull();
  });
  it("refuses an expired topic", () => {
    expect(hotTopicBlockReason({ caption: "Pelle ou patience?", expiresAt: nowSec - 1, nowSec })).toMatch(/périmé/);
  });
  it("refuses a caption that hits the hard blocklist, even if the draft was fine when written", () => {
    expect(hotTopicBlockReason({ caption: "Après le procès, trop payé?", expiresAt: nowSec + 3600, nowSec })).toMatch(/liste noire/);
  });
});

describe("expiry travels with the draft into the publication queue", () => {
  const base = {
    id: 1, sku: "X", triggerType: "hot_topic", language: "fr", postText: "Pelle ou patience?", postTextEn: null,
    imagePath: null, imageUrl: "https://blob.test/c.png", imageUrls: ["https://blob.test/c.png"], oldPrice: null, newPrice: null,
    status: "approved", scheduledAt: null, publishedAt: null, facebookPostId: null, channels: {}, createdAt: 0, hookId: null,
    approvedAt: null, reviewedBy: null, reviewNotes: null, unsplashImageUrl: null, unsplashPhotographer: null, unsplashPhotographerUrl: null,
  } as unknown as FacebookDraft;
  it("adds notAfter for a hot_topic draft", () => {
    const [item] = draftToQueueItems({ ...base, topicMeta: { expiresAt: 1_800_000_000 } }, ["fb_ameublo"]);
    expect(item.payload.notAfter).toBe(1_800_000_000);
  });
  it("adds nothing for other drafts or when there is no expiry", () => {
    expect(draftToQueueItems({ ...base, topicMeta: null }, ["fb_ameublo"])[0].payload).not.toHaveProperty("notAfter");
    expect(draftToQueueItems({ ...base, triggerType: "content_template", topicMeta: { expiresAt: 1 } }, ["fb_ameublo"])[0].payload).not.toHaveProperty("notAfter");
  });
});
