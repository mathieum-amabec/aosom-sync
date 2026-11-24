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
  return { ...real, renderCardPng: vi.fn(async (l: string, q: string) => ({ png: Buffer.from("png"), layout: real.layoutCard(l, q) })), uploadCardPng: vi.fn(async () => "https://blob.test/card.png") };
});
const collect = vi.fn();
vi.mock("@/lib/hot-topics/sources", async (orig) => {
  const real = await orig<typeof import("@/lib/hot-topics/sources")>();
  return { ...real, collectCandidates: (...a: unknown[]) => collect(...a) };
});

import { checkBrandSafety, normalizeForSafety } from "@/lib/hot-topics/safety";
import { parseTrendsRss, parseHeadlineRss, decodeXmlText } from "@/lib/hot-topics/sources";
import { buildCardSvg, layoutCard, wrapText } from "@/lib/hot-topics/card";
import { extractJsonArray, validateProposal, filterCandidates } from "@/lib/hot-topics/generator";
import { runHotTopics, topicSimilarity, isRecentDuplicate, parseMode, parseCap } from "@/lib/hot-topics/run";

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
  ])("blocks %s", (t) => expect(checkBrandSafety(t).safe).toBe(false));
  it.each([
    "Le Canadien a-t-il trop payé pour Larkin?",
    "Première bordée de neige: pelle ou patience?",
    "Le gardien arrête 40 tirs et le Tricolore gagne",
    "Rappel du défenseur: bon coup?",
    "Noël en novembre: trop tôt pour le sapin?",
  ])("lets %s through", (t) => expect(checkBrandSafety(t).safe).toBe(true));
  it("matches whole words only (no 'caq' inside another word)", () => {
    expect(checkBrandSafety("la baraque du coin").safe).toBe(true);
  });
  it("reports the group and the match", () => {
    expect(checkBrandSafety("Un incendie ravage un entrepôt")).toMatchObject({ safe: false, group: "tragedie", match: "incendie" });
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
});

describe("card layout", () => {
  it("wraps greedily and keeps over-long words whole", () => {
    expect(wrapText("un deux trois quatre", 9)).toEqual(["un deux", "trois", "quatre"]);
    expect(wrapText("anticonstitutionnellement", 5)).toEqual(["anticonstitutionnellement"]);
  });
  it("shrinks the font for long questions and keeps a gap line after the lead", () => {
    const short = layoutCard("Tu en penses quoi?", "Pelle ou patience?");
    const long = layoutCard("Tu en penses quoi?", "Est-ce que le Canadien a trop payé pour obtenir un joueur de centre de calibre mondial cette année?");
    expect(long.fontSize).toBeLessThan(short.fontSize);
    expect(short.lines).toContain("");
  });
  it("escapes XML in the SVG and sets the brand red", () => {
    const { svg } = buildCardSvg("A & B", "Tu <aimes> ça?");
    expect(svg).toContain("A &amp; B");
    expect(svg).toContain("&lt;aimes&gt;");
    expect(svg).toContain("#CF2C42");
    expect(svg).not.toContain("<aimes>");
  });
});

const good = {
  index: 1, category: "sport", brand_safe: true, divisive: 4,
  lead: "Tu en penses quoi?", question: "Le Canadien a-t-il trop payé pour Larkin?",
  caption: "Larkin arrive à Montréal. Le Canadien a-t-il trop payé pour lui?", why: "sujet chaud local",
};
const cands = [{ title: "Larkin arrive à Montréal", source: "jdm-sports" }];

describe("proposal validation", () => {
  it("accepts a clean proposal", () => {
    const r = validateProposal(good, cands);
    expect("post" in r && r.post.question).toBe(good.question);
  });
  it.each([
    ["not flagged safe", { brand_safe: false }],
    ["bad category", { category: "politique" }],
    ["no question mark", { question: "Le Canadien a trop payé" }],
    ["caption not a question", { caption: "Larkin arrive à Montréal." }],
    ["hashtag", { caption: "Larkin arrive #Habs. Trop payé?" }],
    ["engagement bait", { caption: "Commente si tu es d'accord. Trop payé?" }],
    ["supplier name", { caption: "Comme chez Aosom: trop payé?" }],
    ["blocklisted word", { caption: "Après le procès, trop payé?" }],
    ["unknown index", { index: 9 }],
    ["card question too long", { question: "x".repeat(121) + "?" }],
  ])("rejects: %s", (_n, patch) => {
    expect("reason" in validateProposal({ ...good, ...patch }, cands)).toBe(true);
  });
  it("extracts JSON from fenced / chatty replies and tolerates garbage", () => {
    expect(extractJsonArray("Voici:\n```json\n[{\"a\":1}]\n```")).toEqual([{ a: 1 }]);
    expect(extractJsonArray("rien")).toEqual([]);
    expect(extractJsonArray("[oops")).toEqual([]);
  });
  it("drops blocklisted candidates before the model sees them", () => {
    const { kept, blocked } = filterCandidates([
      { title: "Élections: qui gagne?", source: "x" },
      { title: "Tempête de neige demain", source: "x", context: ["Environnement Canada prévoit 20 cm"] },
      { title: "Un trend", source: "x", context: ["Mort d'un acteur"] },
    ]);
    expect(kept.map((c) => c.title)).toEqual(["Tempête de neige demain"]);
    expect(blocked).toBe(2);
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
    const r = await runHotTopics();
    expect(r.skipped).toMatch(/off/);
    expect(collect).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("dry mode plans but stores nothing", async () => {
    settings.set("hot_topics_mode", "dry");
    const r = await runHotTopics();
    expect(r.chosen?.question).toBe(good.question);
    expect(r.chosen?.draftId).toBeUndefined();
    expect(createDraft).not.toHaveBeenCalled();
    expect(settings.has("hot_topics_recent")).toBe(false);
  });

  it("?dry override works even when live, and can never turn live on", async () => {
    settings.set("hot_topics_mode", "live");
    const r = await runHotTopics({ modeOverride: "dry" });
    expect(r.mode).toBe("dry");
    expect(createDraft).not.toHaveBeenCalled();
    settings.set("hot_topics_mode", "off");
    expect((await runHotTopics({ modeOverride: "dry" })).chosen).toBeDefined();
  });

  it("live creates ONE draft in the normal approval flow (hot_topic, fr, card image) and remembers the topic", async () => {
    settings.set("hot_topics_mode", "live");
    const r = await runHotTopics();
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft).toHaveBeenCalledWith({
      sku: "PLACEHOLDER-SKU", triggerType: "hot_topic", language: "fr", postText: good.caption,
      imageUrl: "https://blob.test/card.png", imageUrls: ["https://blob.test/card.png"],
    });
    expect(r.chosen?.draftId).toBe(77);
    expect(JSON.parse(settings.get("hot_topics_recent")!)[0].title).toBe("Larkin arrive à Montréal");
  });

  it("respects the weekly cap", async () => {
    settings.set("hot_topics_mode", "live");
    countSince.mockResolvedValue(2);
    const r = await runHotTopics();
    expect(r.skipped).toMatch(/plafond/);
    expect(collect).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("does not repeat a topic already used this week", async () => {
    settings.set("hot_topics_mode", "live");
    await runHotTopics();
    createDraft.mockClear();
    const r = await runHotTopics();
    expect(r.skipped).toMatch(/nouveau/);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("skips quietly when every source is down", async () => {
    settings.set("hot_topics_mode", "live");
    collect.mockResolvedValue({ candidates: [], feeds: { f: "error:HTTP 503" } });
    const r = await runHotTopics();
    expect(r.skipped).toMatch(/source/);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("creates nothing when the model's only proposal fails validation", async () => {
    settings.set("hot_topics_mode", "live");
    llmReply.mockReturnValue(JSON.stringify([{ ...good, caption: "Après le procès, trop payé?" }]));
    const r = await runHotTopics();
    expect(createDraft).not.toHaveBeenCalled();
    expect(r.rejected?.[0].reason).toMatch(/liste noire/);
  });
});
