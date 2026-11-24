import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks (run.ts + generator.ts depend on DB / LLM / network) ────────────────
const settings = new Map<string, string>();
const createDraft = vi.fn();
const countSince = vi.fn();
vi.mock("@/lib/database", () => ({
  getSetting: vi.fn(async (k: string) => settings.get(k) ?? null),
  setSetting: vi.fn(async (k: string, v: string) => { settings.set(k, v); }),
  createFacebookDraft: (...a: unknown[]) => createDraft(...a),
  countFacebookDraftsSince: (...a: unknown[]) => countSince(...a),
  getAnyProductSku: vi.fn(async () => "PLACEHOLDER-SKU"),
}));
const llmReply = vi.fn();
vi.mock("@/lib/content-generator", () => ({ getAnthropicClient: () => ({}) }));
vi.mock("@/lib/llm-models", () => ({ llmModel: () => "test-model" }));
vi.mock("@/lib/llm-budget", () => ({
  budgetedCreate: vi.fn(async () => ({ content: [{ type: "text", text: llmReply() }] })),
}));
vi.mock("@/lib/hot-topics/card", async (orig) => {
  const real = await orig<typeof import("@/lib/hot-topics/card")>();
  return { ...real, renderCardPng: vi.fn(async (f: string, q: string) => ({ png: Buffer.from("png"), layout: real.layoutCard(f, q) })), uploadCardPng: vi.fn(async () => "https://blob.test/card.png") };
});
const collect = vi.fn();
vi.mock("@/lib/hot-topics/sources", async (orig) => {
  const real = await orig<typeof import("@/lib/hot-topics/sources")>();
  return { ...real, collectCandidates: (...a: unknown[]) => collect(...a) };
});

import { checkBrandSafety, normalizeForSafety, softHits } from "@/lib/hot-topics/safety";
import { parseTrendsRss, parseHeadlineRss, decodeXmlText, parsePubDate, markTrending, markBuzz, type TopicCandidate } from "@/lib/hot-topics/sources";
import { buildCardSvg, layoutCard, wrapText } from "@/lib/hot-topics/card";
import { extractJsonArray, validateProposal, filterCandidates, rankPosts, checkPostText, numbersIn, midSentenceProperNouns } from "@/lib/hot-topics/generator";
import { runHotTopics, topicSimilarity, isRecentDuplicate, isRecentCalendar, kindOrder, parseMode, parseCap } from "@/lib/hot-topics/run";

// A Tuesday with several calendar posts active (Vendredi fou in 3 days, pneus d'hiver in 7, sapin in 31)…
const NOW = new Date("2026-11-24T15:00:00Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
// …and a quiet day with none.
const QUIET = new Date("2026-09-15T15:00:00Z");

describe("brand safety blocklist", () => {
  it("normalises accents and punctuation", () => {
    expect(normalizeForSafety("L'Élection — «Légault»!")).toBe("l election legault");
  });
  it.each([
    "Élections provinciales: qui va gagner?",
    "Le premier ministre annonce une réforme",
    "Mort d'un ancien joueur du Canadien",
    "Procès d'un animateur connu",
    "Guerre en Ukraine: nouvelles sanctions",
    "Rappel de produit: listeria",
    "Les élus rejettent la proposition",
    "Une femme retrouvée morte",
    "Le joueur visé par une enquête",
    "Dopage: un athlète suspendu pour",
    "Une surdose dans un bar",
    "La pièce Le dîner de cons revient sur scène",
  ])("blocks %s", (t) => expect(checkBrandSafety(t).safe).toBe(false));
  it.each([
    "Le Canadien a-t-il trop payé pour Larkin?",
    "Première bordée de neige: pelle ou patience?",
    "Le gardien arrête 40 tirs et le Tricolore gagne",
    "Rappel du défenseur: bon coup?",
    "Noël en novembre: trop tôt pour le sapin?",
    "Mort de rire devant le dernier gala",
    "Le Canadien perd en mort subite",
  ])("lets %s through", (t) => expect(checkBrandSafety(t).safe).toBe(true));
  it("matches whole words only (no 'caq' inside another word)", () => {
    expect(checkBrandSafety("la baraque du coin").safe).toBe(true);
  });
  it("reports the group and the match", () => {
    expect(checkBrandSafety("Un incendie ravage un entrepôt")).toMatchObject({ safe: false, group: "tragedie", match: "incendie" });
  });
  it("has a soft tier: allowed in a source headline but reported, and never allowed inside the post", () => {
    expect(checkBrandSafety("Larkin blessé à l'entraînement")).toEqual({ safe: true, soft: ["blesse"] });
    expect(softHits("Suspension de deux matchs, rumeurs d'échange")).toEqual(expect.arrayContaining(["suspension", "rumeurs"]));
    expect(softHits("Bordée de neige demain")).toEqual([]);
    expect(checkPostText({ factLine: "Larkin est blessé.", question: "Il revient quand?", caption: "Larkin est blessé. Il revient quand?" })).toMatch(/sensible/);
  });
});

describe("feed parsing", () => {
  it("decodes CDATA and entities", () => {
    expect(decodeXmlText("<![CDATA[ L&apos;arrivée &amp; plus ]]>")).toBe("L'arrivée & plus");
  });
  it("parses Google Trends items with traffic + news context", () => {
    const xml = `<rss><channel><item><title>dylan larkin</title><ht:approx_traffic>500+</ht:approx_traffic>
      <ht:news_item><ht:news_item_title>Larkin joue ce soir</ht:news_item_title></ht:news_item></item></channel></rss>`;
    expect(parseTrendsRss(xml, "t", 5)).toEqual([{ title: "dylan larkin", source: "t", context: ["Larkin joue ce soir"], traffic: "500+" }]);
  });
  it("parses headline RSS, skips tiny titles, honours the limit", () => {
    const xml = `<rss><channel><title>Feed</title>
      <item><title><![CDATA[Deuxième période | Kings 2 - Canadien 1]]></title></item>
      <item><title>Ok</title></item>
      <item><title>Larkin jouera ce soir au Centre Bell</title></item></channel></rss>`;
    expect(parseHeadlineRss(xml, "s", 1).map((c) => c.title)).toEqual(["Deuxième période | Kings 2 - Canadien 1"]);
    expect(parseHeadlineRss(xml, "s", 9)).toHaveLength(2);
  });
  it("reads pubDate / link / summary and drops stale or undated items when a max age is given", () => {
    const xml = `<rss><channel>
      <item><title>Larkin jouera ce soir au Centre Bell</title><link>https://jdm.test/a</link>
        <description><![CDATA[<p>Le centre sera de retour dans l'alignement du Canadien ce soir.</p>]]></description>
        <pubDate>Tue, 24 Nov 2026 08:30:00 EST</pubDate></item>
      <item><title>Une très vieille nouvelle de hockey</title><pubDate>Fri, 20 Nov 2026 08:30:00 EST</pubDate></item>
      <item><title>Une nouvelle sans date de parution</title></item></channel></rss>`;
    const fresh = parseHeadlineRss(xml, "jdm", 9, { now: NOW, maxAgeHours: 30 });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ title: "Larkin jouera ce soir au Centre Bell", kind: "news", url: "https://jdm.test/a" });
    expect(fresh[0].published).toBe(parsePubDate("Tue, 24 Nov 2026 08:30:00 EST"));
    expect(fresh[0].context?.[0]).toMatch(/retour dans l'alignement/);
    // Without a max age nothing is filtered (old behaviour, used by tests).
    expect(parseHeadlineRss(xml, "jdm", 9)).toHaveLength(3);
  });
  it("parses RFC-822 and numeric-offset dates, rejects garbage", () => {
    expect(parsePubDate("Mon, 23 Nov 2026 12:03:24 EST")).toBe(Date.UTC(2026, 10, 23, 17, 3, 24) / 1000);
    expect(parsePubDate("Tue, 24 Nov 2026 07:00:00 -0500")).toBe(Date.UTC(2026, 10, 24, 12, 0, 0) / 1000);
    expect(parsePubDate("hier")).toBeUndefined();
    expect(parsePubDate(null)).toBeUndefined();
  });
  it("cross-source buzz: a name carried by several headlines is the one everybody talks about", () => {
    const mk = (title: string): TopicCandidate => ({ title, source: "a" });
    const c = [
      mk("Plus excités d'accueillir Dylan Larkin"), mk("Dylan Larkin: le complément idéal"), mk("Acquisition de Dylan Larkin: le pari de Hughes"),
      mk("Un vestiaire emballé par Larkin"), mk("Critique | Un Werther et ses artifices"), mk("Le Canadien perd contre les Kings"),
    ];
    markBuzz(c);
    expect(c.map((x) => x.buzz ?? 0)).toEqual([3, 3, 3, 3, 0, 0]);
  });
  it("Google Trends is only a popularity marker: matching headlines get trending, others don't", () => {
    const c: TopicCandidate[] = [
      { title: "Dylan Larkin jouera ce soir", source: "a" },
      { title: "Tempête de neige annoncée", source: "a" },
    ];
    markTrending(c, ["dylan larkin", "x"]);
    expect(c.map((x) => !!x.trending)).toEqual([true, false]);
  });
});

describe("card layout", () => {
  it("wraps greedily and keeps over-long words whole", () => {
    expect(wrapText("un deux trois quatre", 9)).toEqual(["un deux", "trois", "quatre"]);
    expect(wrapText("anticonstitutionnellement", 5)).toEqual(["anticonstitutionnellement"]);
  });
  it("sets the fact line smaller than the question and shrinks both for long text", () => {
    const short = layoutCard("Le CH joue ce soir.", "Pelle ou patience?");
    const long = layoutCard(
      "Le Canadien a perdu 3-4 contre les Flyers de Philadelphie samedi soir en prolongation.",
      "Est-ce que le Canadien a trop payé pour obtenir un joueur de centre de calibre mondial cette année?",
    );
    expect(short.factFontSize).toBeLessThan(short.fontSize);
    expect(long.fontSize).toBeLessThan(short.fontSize);
    expect(short.factLines.length).toBeGreaterThan(0);
    expect(short.lines.length).toBeGreaterThan(0);
  });
  it("still renders a question-only card when there is no fact line", () => {
    const l = layoutCard("", "Pelle ou patience?");
    expect(l.factLines).toEqual([]);
    expect(l.lines.join(" ")).toBe("Pelle ou patience?");
  });
  it("escapes XML in the SVG and sets the brand red", () => {
    const { svg } = buildCardSvg("A & B", "Tu <aimes> ça?");
    expect(svg).toContain("A &amp; B");
    expect(svg).toContain("&lt;aimes&gt;");
    expect(svg).toContain("#CF2C42");
    expect(svg).not.toContain("<aimes>");
  });
});

// A fresh, named story. The model must NAME the subject and may only use what the headline says.
const larkin: TopicCandidate = {
  title: "Dylan Larkin arrive à Montréal pour trois joueurs",
  source: "jdm-hockey", kind: "news", published: NOW_SEC - 3 * 3600, url: "https://jdm.test/larkin",
  context: ["Le Canadien a obtenu le centre des Red Wings de Detroit."],
};
const good = {
  index: 1, category: "sport", brand_safe: true, divisive: 4, subject: "Larkin",
  fact_line: "Dylan Larkin arrive à Montréal pour trois joueurs.",
  question: "Le Canadien a-t-il trop payé pour Larkin?",
  caption: "Larkin arrive à Montréal pour trois joueurs. Le Canadien a-t-il trop payé pour lui?",
  why: "sujet chaud local",
};
const cands = [larkin];

describe("proposal validation", () => {
  it("accepts a clean proposal and keeps the source for the approver", () => {
    const r = validateProposal(good, cands, NOW);
    expect("post" in r).toBe(true);
    if ("post" in r) {
      expect(r.post).toMatchObject({
        kind: "news", subject: "Larkin", factLine: good.fact_line, question: good.question,
        topicKey: larkin.title, sourceUrl: "https://jdm.test/larkin", flags: [],
      });
      expect(r.post.expiresAt).toBe(larkin.published! + 48 * 3600);
    }
  });
  it.each([
    ["not flagged safe", { brand_safe: false }],
    ["bad category", { category: "politique" }],
    ["no question mark", { question: "Le Canadien a trop payé" }],
    ["caption not a question", { caption: "Larkin arrive à Montréal." }],
    ["hashtag", { caption: "Larkin arrive #Habs. Trop payé?" }],
    ["engagement bait", { caption: "Commente si tu es d'accord. Trop payé?" }],
    ["engagement bait (en commentaires)", { caption: "Larkin arrive. Dis-nous en commentaires: trop payé?" }],
    ["supplier name", { caption: "Comme chez Aosom: trop payé?" }],
    ["blocklisted word", { caption: "Après le procès, trop payé?" }],
    ["sensitive word in the post", { caption: "Larkin, blessé, arrive. Trop payé?" }],
    ["unknown index", { index: 9 }],
    ["card question too long", { question: "x".repeat(121) + "?" }],
    ["fact line too long", { fact_line: "x".repeat(111) }],
    ["fact line is a question", { fact_line: "Dylan Larkin arrive à Montréal?" }],
    ["two emoji", { caption: "Larkin arrive. Trop payé? 🏒🔥" }],
  ])("rejects: %s", (_n, patch) => {
    expect("reason" in validateProposal({ ...good, ...patch }, cands, NOW)).toBe(true);
  });

  it("requires a NAMED subject that is in the source and on the card", () => {
    const reason = (patch: object) => {
      const r = validateProposal({ ...good, ...patch }, cands, NOW);
      return "reason" in r ? r.reason : "";
    };
    expect(reason({ subject: "" })).toMatch(/sujet nommé absent/);
    expect(reason({ subject: "Suzuki" })).toMatch(/absent de la source/);
    expect(reason({ fact_line: "Le Canadien a fait une transaction importante." })).toMatch(/pas nommé sur la carte/);
    // Vague card of the v1 kind: no subject at all.
    expect(reason({ subject: undefined, fact_line: "Gros coup du CH." })).toMatch(/sujet/);
  });

  it("rejects any number or proper noun that is not in the source (no invented details)", () => {
    const reason = (patch: object) => {
      const r = validateProposal({ ...good, ...patch }, cands, NOW);
      return "reason" in r ? r.reason : "";
    };
    expect(reason({ caption: "Larkin arrive pour 8 millions. Le Canadien a-t-il trop payé?" })).toMatch(/chiffre absent/);
    expect(reason({ question: "Le Canadien a-t-il trop payé pour Larkin ou pour Hughes?" })).toMatch(/nom propre absent/);
    // A number that IS in the source passes.
    const withNumber = { ...cands[0], title: "Dylan Larkin arrive à Montréal pour 3 joueurs" };
    expect("post" in validateProposal({ ...good, fact_line: "Dylan Larkin arrive à Montréal pour 3 joueurs." }, [withNumber], NOW)).toBe(true);
  });

  it("states a hard NHL fact itself — the model cannot swap the score", () => {
    const fact: TopicCandidate = {
      title: "Le Canadien a perdu 3-4 contre les Flyers de Philadelphie samedi soir", source: "nhl-api", kind: "fact", published: NOW_SEC - 3600,
    };
    const r = validateProposal(
      { ...good, subject: "Flyers", fact_line: "Le Canadien a gagné 4-3.", question: "Le Canadien manque-t-il de profondeur?", caption: "Le Canadien a perdu 3-4. Il manque de profondeur?" },
      [fact], NOW,
    );
    expect("post" in r && r.post.factLine).toBe(`${fact.title}.`);
  });

  it("flags a sensitive SOURCE headline for the approver instead of dropping it", () => {
    const hurt: TopicCandidate = { ...larkin, context: ["Larkin blessé à l'entraînement, mais le Canadien a obtenu un défenseur."] };
    const r = validateProposal(good, [hurt], NOW);
    expect("post" in r && r.post.flags).toEqual(["blesse"]);
  });

  it("extracts JSON from fenced / chatty replies and tolerates garbage", () => {
    expect(extractJsonArray("Voici:\n```json\n[{\"a\":1}]\n```")).toEqual([{ a: 1 }]);
    expect(extractJsonArray("rien")).toEqual([]);
    expect(extractJsonArray("[oops")).toEqual([]);
  });

  it("helper extractors: numbers and mid-sentence proper nouns", () => {
    expect(numbersIn("4-3, 12,5 millions et 7.2")).toEqual(["4", "3", "12.5", "7.2"]);
    expect(midSentenceProperNouns("Le Canadien affronte Boston. Larkin est de retour, Suzuki aussi")).toEqual(["Canadien", "Boston", "Suzuki"]);
  });

  it("drops stale, undated and blocklisted candidates before the model sees them", () => {
    const fresh = NOW_SEC - 3600;
    const { kept, blocked } = filterCandidates([
      { title: "Élections: qui gagne?", source: "x", published: fresh },
      { title: "Tempête de neige demain", source: "x", published: fresh, context: ["Environnement Canada prévoit 20 cm"] },
      { title: "Un trend", source: "x", published: fresh, context: ["Mort d'un acteur"] },
      { title: "Une bordée d'il y a quatre jours", source: "x", published: NOW_SEC - 96 * 3600 },
      { title: "Une manchette sans date", source: "x" },
      { title: "Larkin blessé, le Canadien gagne", source: "x", published: fresh },
    ], NOW);
    expect(kept.map((c) => c.title)).toEqual(["Tempête de neige demain", "Larkin blessé, le Canadien gagne"]);
    expect(blocked).toBe(4);
  });

  it("ranks unflagged first, then trending, then most divisive", () => {
    const mk = (flags: string[], trending: boolean, divisive: number) =>
      ({ flags, trending, divisive } as unknown as Parameters<typeof rankPosts>[0][number]);
    const ranked = rankPosts([mk(["blesse"], true, 5), mk([], false, 2), mk([], true, 1), mk([], true, 4)]);
    expect(ranked.map((p) => [p.flags.length, p.trending, p.divisive])).toEqual([[0, true, 4], [0, true, 1], [0, false, 2], [1, true, 5]]);
    // A story carried by ≥ 3 other headlines beats a merely trending one.
    const buzzy = { ...mk([], false, 1), buzz: 7 } as unknown as Parameters<typeof rankPosts>[0][number];
    expect(rankPosts([mk([], true, 5), buzzy])[0]).toBe(buzzy);
  });
});

describe("dedupe + settings parsing", () => {
  it("scores similar headlines high and unrelated ones low", () => {
    expect(topicSimilarity("Larkin arrive à Montréal", "L'arrivée de Dylan Larkin à Montréal")).toBeGreaterThanOrEqual(0.4);
    expect(topicSimilarity("Larkin arrive à Montréal", "Tempête de neige demain")).toBe(0);
  });
  it("only considers the last 7 days", () => {
    const now = 1_000_000_000;
    const recent = [{ title: "Larkin arrive à Montréal", at: now - 8 * 86400, draftId: 1 }];
    expect(isRecentDuplicate("Larkin arrive à Montréal", recent, now)).toBe(false);
    expect(isRecentDuplicate("Larkin arrive à Montréal", [{ ...recent[0], at: now - 86400 }], now)).toBe(true);
  });
  it("calendar posts repeat only by exact key, after 10 days", () => {
    const now = 1_000_000_000;
    expect(isRecentCalendar("calendrier:pneus-hiver", [{ title: "calendrier:pneus-hiver", at: now - 5 * 86400, draftId: 1 }], now)).toBe(true);
    expect(isRecentCalendar("calendrier:pneus-hiver", [{ title: "calendrier:pneus-hiver", at: now - 11 * 86400, draftId: 1 }], now)).toBe(false);
    expect(isRecentCalendar("calendrier:sapin-noel", [{ title: "calendrier:pneus-hiver", at: now - 86400, draftId: 1 }], now)).toBe(false);
  });
  it("alternates the kind: the one not used this week goes first", () => {
    const now = 1_000_000_000;
    const used = (kind: "news" | "calendar", ageDays = 1) => ({ title: "t", at: now - ageDays * 86400, draftId: 1, kind });
    expect(kindOrder([], now)).toEqual(["news", "calendar"]);
    expect(kindOrder([used("news")], now)).toEqual(["calendar", "news"]);
    expect(kindOrder([used("calendar")], now)).toEqual(["news", "calendar"]);
    expect(kindOrder([used("news"), used("calendar")], now)).toEqual(["news", "calendar"]);
    expect(kindOrder([used("news", 9)], now)).toEqual(["news", "calendar"]);
  });
  it("defaults to off and cap 2", () => {
    expect(parseMode(null)).toBe("off");
    expect(parseMode("LIVE")).toBe("live");
    expect(parseMode("pilot")).toBe("off");
    expect(parseCap(null)).toBe(2);
    expect(parseCap("3")).toBe(3);
    expect(parseCap("99")).toBe(2);
  });
});

describe("runHotTopics", () => {
  beforeEach(() => {
    settings.clear();
    createDraft.mockReset().mockResolvedValue(77);
    countSince.mockReset().mockResolvedValue(0);
    collect.mockReset().mockResolvedValue({ candidates: cands, feeds: { f: "ok:1" } });
    llmReply.mockReset().mockReturnValue(JSON.stringify([good]));
  });

  it("is a no-op when the mode is off (default) — no network, no draft", async () => {
    const r = await runHotTopics({ now: NOW });
    expect(r.skipped).toMatch(/off/);
    expect(collect).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("dry mode plans a news post, lists the calendar posts as alternatives, stores nothing", async () => {
    settings.set("hot_topics_mode", "dry");
    const r = await runHotTopics({ now: NOW });
    expect(r.chosen).toMatchObject({ kind: "news", question: good.question, subject: "Larkin", sourceUrl: "https://jdm.test/larkin" });
    expect(r.chosen?.draftId).toBeUndefined();
    expect(r.alternatives?.map((a) => a.kind)).toContain("calendar");
    expect(createDraft).not.toHaveBeenCalled();
    expect(settings.has("hot_topics_recent")).toBe(false);
  });

  it("?dry override works even when live, and can never turn live on", async () => {
    settings.set("hot_topics_mode", "live");
    const r = await runHotTopics({ modeOverride: "dry", now: NOW });
    expect(r.mode).toBe("dry");
    expect(createDraft).not.toHaveBeenCalled();
    settings.set("hot_topics_mode", "off");
    expect((await runHotTopics({ modeOverride: "dry", now: NOW })).chosen).toBeDefined();
  });

  it("live creates ONE draft in the normal approval flow, with its source and expiry, and remembers the topic", async () => {
    settings.set("hot_topics_mode", "live");
    const r = await runHotTopics({ now: NOW });
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({
      sku: "PLACEHOLDER-SKU", triggerType: "hot_topic", language: "fr", postText: good.caption,
      imageUrl: "https://blob.test/card.png", imageUrls: ["https://blob.test/card.png"],
      topicMeta: expect.objectContaining({
        kind: "news", sourceTitle: larkin.title, sourceUrl: "https://jdm.test/larkin", subject: "Larkin",
        factLine: good.fact_line, expiresAt: larkin.published! + 48 * 3600,
      }),
    }));
    expect(r.chosen?.draftId).toBe(77);
    expect(JSON.parse(settings.get("hot_topics_recent")!)[0]).toMatchObject({ title: larkin.title, kind: "news", draftId: 77 });
  });

  it("respects the weekly cap", async () => {
    settings.set("hot_topics_mode", "live");
    countSince.mockResolvedValue(2);
    const r = await runHotTopics({ now: NOW });
    expect(r.skipped).toMatch(/plafond/);
    expect(collect).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("second run of the week switches to the calendar kind — no repeat, and no LLM call needed", async () => {
    settings.set("hot_topics_mode", "live");
    await runHotTopics({ now: NOW });
    createDraft.mockClear();
    collect.mockClear();
    const r = await runHotTopics({ now: NOW });
    expect(r.chosen?.kind).toBe("calendar");
    expect(collect).not.toHaveBeenCalled();
    const meta = createDraft.mock.calls[0][0].topicMeta;
    expect(meta).toMatchObject({ kind: "calendar", source: "calendrier", sourceUrl: null });
    expect(meta.topicKey).toMatch(/^calendrier:/);
    expect(typeof meta.expiresAt).toBe("number");
  });

  it("falls back to the calendar when the news side has nothing safe and new", async () => {
    settings.set("hot_topics_mode", "live");
    llmReply.mockReturnValue("[]");
    const r = await runHotTopics({ now: NOW });
    expect(r.chosen?.kind).toBe("calendar");
  });

  it("skips quietly when every source is down and the calendar is empty", async () => {
    settings.set("hot_topics_mode", "live");
    collect.mockResolvedValue({ candidates: [], feeds: { f: "error:HTTP 503" } });
    const r = await runHotTopics({ now: QUIET });
    expect(r.skipped).toMatch(/aucun sujet/);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("creates nothing when the model's only proposal fails validation and no calendar post is active", async () => {
    settings.set("hot_topics_mode", "live");
    collect.mockResolvedValue({ candidates: [{ ...larkin, published: Math.floor(QUIET.getTime() / 1000) - 3600 }], feeds: { f: "ok:1" } });
    llmReply.mockReturnValue(JSON.stringify([{ ...good, caption: "Après le procès, trop payé?" }]));
    const r = await runHotTopics({ now: QUIET });
    expect(createDraft).not.toHaveBeenCalled();
    expect(r.rejected?.[0].reason).toMatch(/liste noire/);
  });
});

describe("caption ending", () => {
  it("accepts a trailing emoji after the question mark but not a statement", () => {
    expect("post" in validateProposal({ ...good, caption: "Larkin arrive. Trop payé? 🏒" }, cands, NOW)).toBe(true);
    expect("reason" in validateProposal({ ...good, caption: "Larkin arrive. Trop payé?! Wow." }, cands, NOW)).toBe(true);
  });
});
