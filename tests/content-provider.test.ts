/**
 * CONTENT_PROVIDER switch + guardrails, end to end through generateProductContent():
 * which model writes the first draft, when it escalates, and what the deterministic
 * guards / the single corrective retry do to the result.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", () => ({
  env: { anthropicApiKey: "test-key" },
  CLAUDE: { MODEL: "claude-strong", MODEL_BATCH: "claude-cheap", MAX_TOKENS_CONTENT: 1000 },
}));

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

const { geminiGenerate } = vi.hoisted(() => ({ geminiGenerate: vi.fn() }));
vi.mock("@/lib/gemini-client", () => ({ geminiGenerate }));

const { generateProductContent } = await import("@/lib/content-generator");

const TAGS = ["abri", "remise", "garden shed", "tool storage", "outdoor storage", "jardin", "patio", "rangement"];

function listing(over: Record<string, unknown> = {}) {
  return {
    titleFr: "Chaise longue pliante",
    titleEn: "Folding lounge chair",
    descriptionFr: "<p>Cette chaise pour votre jardin est confortable et pratique pour tous les jours.</p>",
    descriptionEn: "<p>This chair is comfortable.</p>",
    seoDescriptionFr: "desc fr",
    seoDescriptionEn: "desc en",
    metaTitleFr: "m fr | Livraison gratuite — Ameublo Direct",
    metaTitleEn: "m en | Free Shipping — Furnish Direct",
    metaDescriptionFr: "md fr",
    metaDescriptionEn: "md en",
    urlHandleFr: "chaise-fr",
    urlHandleEn: "chair-en",
    tags: TAGS,
    ...over,
  };
}

const gemText = (o: unknown) => ({ text: typeof o === "string" ? o : JSON.stringify(o), usage: null });
const claudeMsg = (o: unknown) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });

function product(colors: string[] = ["Noir"]) {
  return {
    name: "Chaise longue",
    description: "<p>Une chaise.</p>",
    shortDescription: "<p>Court.</p>",
    brand: "Outsunny",
    productType: "Chaise",
    material: "Acier",
    variants: colors.map((color, i) => ({ sku: `ABC-${i}`, price: 99, color })),
  } as never;
}

beforeEach(() => {
  create.mockReset();
  geminiGenerate.mockReset();
  delete process.env.CONTENT_PROVIDER;
  delete process.env.GEMINI_CONTENT_MODEL;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.CONTENT_PROVIDER;
  vi.restoreAllMocks();
});

describe("provider routing", () => {
  it("defaults to Claude's cheap model and never calls Gemini", async () => {
    create.mockResolvedValue(claudeMsg(listing()));
    await generateProductContent(product());
    expect(create.mock.calls[0][0].model).toBe("claude-cheap");
    expect(geminiGenerate).not.toHaveBeenCalled();
  });

  it("CONTENT_PROVIDER=gemini writes the first draft with Gemini on the batch pool", async () => {
    process.env.CONTENT_PROVIDER = "gemini";
    geminiGenerate.mockResolvedValue(gemText(listing({ titleFr: "Chaise gemini" })));
    const out = await generateProductContent(product());
    expect(out.titleFr).toBe("Chaise gemini");
    expect(create).not.toHaveBeenCalled();
    const [params, pool] = geminiGenerate.mock.calls[0];
    expect(params.model).toBe("gemini-3.5-flash-lite");
    expect(params.systemInstruction).toContain("bilingual e-commerce copywriter");
    expect(pool).toBe("batch");
  });

  it("honours GEMINI_CONTENT_MODEL", async () => {
    process.env.CONTENT_PROVIDER = "gemini";
    process.env.GEMINI_CONTENT_MODEL = "gemini-test-x";
    geminiGenerate.mockResolvedValue(gemText(listing()));
    await generateProductContent(product());
    expect(geminiGenerate.mock.calls[0][0].model).toBe("gemini-test-x");
  });

  it("an unknown CONTENT_PROVIDER value falls back to Claude", async () => {
    process.env.CONTENT_PROVIDER = "gpt";
    create.mockResolvedValue(claudeMsg(listing()));
    await generateProductContent(product());
    expect(geminiGenerate).not.toHaveBeenCalled();
  });
});

describe("escalation with a Gemini first tier", () => {
  beforeEach(() => { process.env.CONTENT_PROVIDER = "gemini"; });

  it("re-runs on Claude's strong model when Gemini returns unparseable JSON", async () => {
    geminiGenerate.mockResolvedValue(gemText("not json at all"));
    create.mockResolvedValue(claudeMsg(listing({ titleFr: "Chaise sonnet" })));
    const out = await generateProductContent(product());
    expect(out.titleFr).toBe("Chaise sonnet");
    expect(create.mock.calls[0][0].model).toBe("claude-strong");
  });

  it("escalates when Gemini's descriptionFr is English", async () => {
    geminiGenerate.mockResolvedValue(gemText(listing({ descriptionFr: "<p>The quick brown fox jumps over the lazy dog and runs away with the garden chair.</p>" })));
    create.mockResolvedValue(claudeMsg(listing()));
    await generateProductContent(product());
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does NOT buy a Claude call when Gemini itself fails (API/budget error propagates)", async () => {
    geminiGenerate.mockRejectedValue(new Error("Gemini API 503"));
    await expect(generateProductContent(product())).rejects.toThrow("Gemini API 503");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("title guardrails (whichever model wrote the title)", () => {
  it("converts inches, drops a trailing colour and caps the length", async () => {
    process.env.CONTENT_PROVIDER = "gemini";
    geminiGenerate.mockResolvedValue(
      gemText(listing({
        titleFr: "Tapis de jeu pliant réversible pour bébé 77 x 69 po — gris",
        titleEn: "Foldable reversible baby play mat for crawling toddlers and infants soft foam 77 x 69 in",
      })),
    );
    const out = await generateProductContent(product());
    expect(out.titleFr).toBe("Tapis de jeu pliant réversible pour bébé 196 x 175 cm");
    expect(out.titleEn).not.toMatch(/\bin\b$/);
    expect(out.titleEn.split(/\s+/).length).toBeLessThanOrEqual(12);
  });

  it("strips an inline colour only for a multi-colour product", async () => {
    create.mockResolvedValue(claudeMsg(listing({ titleFr: "Sapin artificiel blanc 213 cm" })));
    expect((await generateProductContent(product(["Blanc", "Vert"]))).titleFr).toBe("Sapin artificiel 213 cm");
    create.mockResolvedValue(claudeMsg(listing({ titleFr: "Sapin artificiel blanc 213 cm" })));
    expect((await generateProductContent(product(["Blanc"]))).titleFr).toBe("Sapin artificiel blanc 213 cm");
  });
});

describe("single corrective retry for soft problems", () => {
  beforeEach(() => { process.env.CONTENT_PROVIDER = "gemini"; });
  const bad = () => listing({ descriptionFr: "<p>Cette chaise est confortable. Hauteur de 38,25 po pour votre salon et pour tous les jours.</p>" });

  it("asks the SAME model once, with the problem named, and keeps the fixed draft", async () => {
    geminiGenerate
      .mockResolvedValueOnce(gemText(bad()))
      .mockResolvedValueOnce(gemText(listing({ descriptionFr: "<p>Cette chaise est confortable. Hauteur de 97 cm (38,25 po) pour votre salon et pour tous les jours.</p>" })));
    const out = await generateProductContent(product());
    expect(geminiGenerate).toHaveBeenCalledTimes(2);
    const secondPrompt = geminiGenerate.mock.calls[1][0].contents[0].parts[0].text as string;
    expect(secondPrompt).toContain("38,25 po");
    expect(secondPrompt).toContain("COMPLETE JSON");
    expect(out.descriptionFr).toContain("97 cm");
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the draft (no third call, no escalation) when the retry is still imperfect", async () => {
    geminiGenerate.mockResolvedValue(gemText(bad()));
    const out = await generateProductContent(product());
    expect(geminiGenerate).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
    expect(out.descriptionFr).toContain("38,25 po");
  });

  it("flags too few tags and missing accents the same way", async () => {
    geminiGenerate
      .mockResolvedValueOnce(gemText(listing({ tags: ["a", "b"], titleFr: "Tapis pour bebe" })))
      .mockResolvedValueOnce(gemText(listing()));
    await generateProductContent(product());
    const prompt = geminiGenerate.mock.calls[1][0].contents[0].parts[0].text as string;
    expect(prompt).toContain("only 2 tags");
    expect(prompt).toContain("bebe → bébé");
  });

  it("a failure on the retry propagates as itself — it must not trigger a paid escalation", async () => {
    geminiGenerate.mockResolvedValueOnce(gemText(bad())).mockRejectedValueOnce(new Error("Gemini API 429"));
    await expect(generateProductContent(product())).rejects.toThrow("Gemini API 429");
    expect(create).not.toHaveBeenCalled();
  });

  it("does not retry a clean draft", async () => {
    geminiGenerate.mockResolvedValue(gemText(listing()));
    await generateProductContent(product());
    expect(geminiGenerate).toHaveBeenCalledTimes(1);
  });
});
