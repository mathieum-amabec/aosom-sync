import { describe, it, expect, vi, beforeEach } from "vitest";

// config is read at module load via content-generator; mock it (no real env needed).
vi.mock("@/lib/config", () => ({
  env: { anthropicApiKey: "test-key" },
  CLAUDE: {
    MODEL_ASSISTANT: "claude-haiku-4-5-20251001",
    MODEL: "claude-sonnet-4-6",
    MODEL_BATCH: "claude-haiku-4-5",
    MAX_TOKENS_CONTENT: 1000,
    MAX_TOKENS_SOCIAL: 500,
  },
}));

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));

// budgetedCreate wraps client.messages.create with the daily-budget guard; delegate to the
// mocked create so these tests exercise the tool loop, not the budget bookkeeping.
vi.mock("@/lib/llm-budget", () => ({
  budgetedCreate: (client: { messages: { create: typeof create } }, params: unknown) => client.messages.create(params),
}));

const getProducts = vi.fn();
vi.mock("@/lib/database", () => ({ getProducts }));

// FR-title resolution calls shopifyFetch(/graphql.json). Mock it; default = no match
// (so cards fall back to the catalog name unless a test opts into FR titles).
const shopifyFetch = vi.fn();
vi.mock("@/lib/shopify-client", () => ({ shopifyFetch }));

const { runAssistant, runComplementary } = await import("@/lib/assistant");

const prod = (over: Partial<Record<string, unknown>> = {}) => ({
  sku: "A-1", name: "Sofa sectionnel", price: 499, qty: 5, color: "Gris",
  product_type: "Sofas", image1: "https://img/1.jpg",
  shopify_product_id: "111", shopify_handle: "sofa-sectionnel-gris", ...over,
});
const toolUse = (input: unknown) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "search_catalog", input }] });
const final = (obj: unknown) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(obj) }] });

beforeEach(() => {
  create.mockReset();
  getProducts.mockReset().mockResolvedValue({ products: [prod()], total: 1, productTypes: [] });
  // default: FR-title lookup returns no nodes -> cards fall back to the catalog name
  shopifyFetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ data: { products: { nodes: [] } } }) });
});

describe("runAssistant", () => {
  it("runs the tool loop and returns resolved product cards with PDP links", async () => {
    create
      .mockResolvedValueOnce(toolUse({ query: "sectional sofa" }))
      .mockResolvedValueOnce(final({ reply: "Voici une belle option.", products: [{ sku: "A-1", reason: "Confortable et spacieux" }] }));

    const res = await runAssistant({ message: "je cherche un canapé", locale: "fr" });

    expect(res.reply).toBe("Voici une belle option.");
    expect(res.products).toHaveLength(1);
    expect(res.products[0]).toMatchObject({
      sku: "A-1", name: "Sofa sectionnel", price: 499, image: "https://img/1.jpg", reason: "Confortable et spacieux",
      url: "https://ameublodirect.ca/products/sofa-sectionnel-gris",
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("sends every turn on the assistant model, never the Sonnet escalation tier", async () => {
    // The saving is only real if EVERY call in the loop uses MODEL_ASSISTANT — a tool-use
    // turn left on Sonnet would keep most of the cost, since the loop runs up to MAX_STEPS.
    create.mockResolvedValueOnce(final({ reply: "ok", products: [] }));
    await runAssistant({ message: "une table", locale: "fr" });
    for (const call of create.mock.calls) {
      expect(call[0].model).toBe("claude-haiku-4-5-20251001");
    }
  });

  it("forwards prior conversation history into the model messages (multi-turn refinement)", async () => {
    create.mockResolvedValueOnce(final({ reply: "ok", products: [] }));
    await runAssistant({
      message: "je préfère le gris",
      locale: "fr",
      history: [
        { role: "user", content: "je cherche un canapé pour un petit salon" },
        { role: "assistant", content: "Voici quelques options." },
        { role: "user", content: "j'ai un budget de 500$" },
      ],
    });
    const sentMessages = create.mock.calls[0][0].messages as Array<{ role: string; content: unknown }>;
    // history turns must precede the latest user message, in order.
    const textOf = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : "");
    expect(sentMessages.map(textOf)).toEqual([
      "je cherche un canapé pour un petit salon",
      "Voici quelques options.",
      "j'ai un budget de 500$",
      "je préfère le gris",
    ]);
  });

  it("system prompt distinguishes indoor vs outdoor and instructs multi-turn refinement", async () => {
    create.mockResolvedValueOnce(final({ reply: "ok", products: [] }));
    await runAssistant({ message: "un canapé pour mon salon", locale: "fr" });
    const system = create.mock.calls[0][0].system as string;
    expect(system).toMatch(/INDOOR vs OUTDOOR/);
    expect(system).toMatch(/patio|outdoor/i);
    expect(system).toMatch(/refine|accumulated|maxPrice/i);
  });

  // CHANGED in v0.5.59.3: this asserted `furnishdirect.ca`, which is NXDOMAIN — the test was
  // locking in a dead link for every EN shopper. EN is the /en locale of the same storefront.
  it("uses the /en locale path for locale=en", async () => {
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "Here you go.", products: [{ sku: "A-1", reason: "Comfy" }] }));
    const res = await runAssistant({ message: "I need a sofa", locale: "en" });
    expect(res.products[0].url).toBe("https://ameublodirect.ca/en/products/sofa-sectionnel-gris");
  });

  it("swaps the raw EN catalog name for the curated Shopify FR title on locale=fr", async () => {
    shopifyFetch.mockResolvedValue({
      ok: true,
      // status/onlineStoreUrl added in v0.5.59.3 — the same round-trip now also proves the PDP is live.
      json: async () => ({ data: { products: { nodes: [{ handle: "sofa-sectionnel-gris", title: "Canapé sectionnel gris moderne", status: "ACTIVE", onlineStoreUrl: "https://ameublodirect.ca/products/sofa-sectionnel-gris" }] } } }),
    });
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "ok", products: [{ sku: "A-1", reason: "x" }] }));
    const res = await runAssistant({ message: "canapé", locale: "fr" });
    expect(res.products[0].name).toBe("Canapé sectionnel gris moderne");
  });

  // CHANGED in v0.5.59.3: EN used to skip the Shopify round-trip entirely (FR titles only).
  // It now makes the call for BOTH locales because that call also carries the live/draft
  // check — EN shoppers were being sent to draft PDPs that 404. EN still keeps the EN name.
  it("fetches live status for locale=en but keeps the catalog/EN name", async () => {
    shopifyFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { products: { nodes: [{ handle: "sofa-sectionnel-gris", title: "Canapé sectionnel gris moderne", status: "ACTIVE", onlineStoreUrl: "https://x" }] } } }),
    });
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "ok", products: [{ sku: "A-1", reason: "x" }] }));
    const res = await runAssistant({ message: "I need a sofa", locale: "en" });
    expect(shopifyFetch).toHaveBeenCalledTimes(1);
    expect(res.products[0].name).toBe("Sofa sectionnel"); // NOT the FR title
  });

  it("falls back to the catalog name when the FR-title lookup fails", async () => {
    shopifyFetch.mockRejectedValue(new Error("shopify down"));
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "ok", products: [{ sku: "A-1", reason: "x" }] }));
    const res = await runAssistant({ message: "canapé", locale: "fr" });
    expect(res.products[0].name).toBe("Sofa sectionnel");
  });

  it("drops a picked SKU the tool never returned (model cannot invent a product)", async () => {
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "ok", products: [{ sku: "A-1", reason: "real" }, { sku: "FAKE-999", reason: "invented" }] }));
    const res = await runAssistant({ message: "canapé", locale: "fr" });
    expect(res.products.map((p) => p.sku)).toEqual(["A-1"]);
  });

  it("excludes catalog products with no storefront handle (no dead PDP links)", async () => {
    getProducts.mockResolvedValue({ products: [prod({ shopify_handle: null })], total: 1, productTypes: [] });
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "ok", products: [{ sku: "A-1", reason: "x" }] }));
    const res = await runAssistant({ message: "canapé", locale: "fr" });
    expect(res.products).toHaveLength(0);
  });

  it("falls back gracefully when the model never emits final JSON", async () => {
    // Every step returns tool_use → loop exhausts MAX_STEPS without a final answer.
    create.mockResolvedValue(toolUse({ query: "sofa" }));
    const res = await runAssistant({ message: "canapé", locale: "fr" });
    expect(res.reply).toMatch(/options/i);
    // pool had A-1 → fallback surfaces it
    expect(res.products.map((p) => p.sku)).toContain("A-1");
  });

  it("handles a non-JSON final answer without throwing", async () => {
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "désolé, je ne peux pas" }] });
    const res = await runAssistant({ message: "canapé", locale: "fr" });
    expect(res.products).toHaveLength(0);
    expect(typeof res.reply).toBe("string");
  });

  it("caps the search filters and only sends compact rows to the model", async () => {
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "ok", products: [{ sku: "A-1", reason: "x" }] }));
    await runAssistant({ message: "canapé", locale: "fr" });
    // The tool_result handed back to the model must NOT leak internal fields (handle/image).
    const secondCallMessages = create.mock.calls[1][0].messages as Array<{ role: string; content: unknown }>;
    const toolResultMsg = secondCallMessages.find((m) => m.role === "user" && Array.isArray(m.content));
    const payload = JSON.parse(((toolResultMsg!.content as Array<{ content: string }>)[0]).content);
    expect(payload[0]).toHaveProperty("sku");
    expect(payload[0]).not.toHaveProperty("handle");
    expect(payload[0]).not.toHaveProperty("image");
  });
});

describe("runComplementary", () => {
  it("seeds a complementary-products request and returns cards", async () => {
    create
      .mockResolvedValueOnce(toolUse({ query: "coffee table" }))
      .mockResolvedValueOnce(final({ reply: "Pour compléter :", products: [{ sku: "A-1", reason: "S'agence bien" }] }));
    const res = await runComplementary({ name: "Canapé gris", productType: "Sofas", locale: "fr" });
    expect(res.products).toHaveLength(1);
    // The seed (first user message, index 0 since there's no history) should mention
    // complementary intent. NB: the messages array is mutated in place during the tool
    // loop, so only index 0 is stable — the tail holds later tool-result blocks.
    const firstMessages = create.mock.calls[0][0].messages;
    expect(firstMessages[0].content).toMatch(/complémentaires/i);
  });
});

// ── v0.5.59.3: dead EN domain, draft leakage, budget, empty-state ──────────
const liveNodes = (nodes: unknown[]) => ({ ok: true, json: async () => ({ data: { products: { nodes } } }) });

describe("extractBudget", () => {
  it("reads a budget when a number sits next to a currency marker", async () => {
    const { extractBudget } = await import("@/lib/assistant");
    expect(extractBudget("Je cherche un sofa, budget 800$, style moderne")).toBe(800);
    expect(extractBudget("500 dollars max")).toBe(500);
    expect(extractBudget("1200 CAD")).toBe(1200);
  });
  it("returns null with no currency marker — a false budget would hide the catalogue", async () => {
    const { extractBudget } = await import("@/lib/assistant");
    expect(extractBudget("Je cherche un canape pour mon salon")).toBeNull();
    expect(extractBudget("Jai une petite terrasse 10x10 pieds")).toBeNull();
    expect(extractBudget("un sofa 3 places")).toBeNull();
    expect(extractBudget("lit pour 8 ans")).toBeNull();
  });
  it("takes the lowest ceiling when several figures appear", async () => {
    const { extractBudget } = await import("@/lib/assistant");
    expect(extractBudget("budget 800$ max 600$")).toBe(600);
  });
});

describe("EN locale links (regression: furnishdirect.ca is NXDOMAIN)", () => {
  it("links EN cards to the /en locale path, never furnishdirect.ca", async () => {
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "Here you go.", products: [{ sku: "A-1", reason: "Comfy" }] }));
    const res = await runAssistant({ message: "I need a sofa", locale: "en" });
    expect(res.products[0].url).toBe("https://ameublodirect.ca/en/products/sofa-sectionnel-gris");
    expect(res.products[0].url).not.toContain("furnishdirect");
  });
});

describe("draft / unpublished products never reach the shopper", () => {
  it("drops a card whose Shopify product is draft or not published", async () => {
    shopifyFetch.mockResolvedValue(liveNodes([
      { handle: "sofa-sectionnel-gris", title: "Canapé", status: "DRAFT", onlineStoreUrl: null },
    ]));
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "Voici une option.", products: [{ sku: "A-1", reason: "x" }] }));
    const res = await runAssistant({ message: "canapé", locale: "fr" });
    expect(res.products).toHaveLength(0);
    // and the reply must not still promise options
    expect(res.reply).toContain("Je n'ai pas trouvé");
  });

  it("keeps an ACTIVE product that is published to the Online Store", async () => {
    shopifyFetch.mockResolvedValue(liveNodes([
      { handle: "sofa-sectionnel-gris", title: "Canapé curé", status: "ACTIVE", onlineStoreUrl: "https://ameublodirect.ca/products/sofa-sectionnel-gris" },
    ]));
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "Voici une option.", products: [{ sku: "A-1", reason: "x" }] }));
    const res = await runAssistant({ message: "canapé", locale: "fr" });
    expect(res.products).toHaveLength(1);
    expect(res.products[0].name).toBe("Canapé curé");
  });

  it("fails OPEN — a Shopify outage keeps cards rather than emptying the reply", async () => {
    shopifyFetch.mockRejectedValue(new Error("shopify down"));
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "Voici une option.", products: [{ sku: "A-1", reason: "x" }] }));
    const res = await runAssistant({ message: "canapé", locale: "fr" });
    expect(res.products).toHaveLength(1);
  });
});

describe("budget ceiling", () => {
  it("drops cards above budget x1.2", async () => {
    getProducts.mockResolvedValue({ products: [prod({ sku: "CHEAP", price: 700, shopify_handle: "cheap" }), prod({ sku: "RICH", price: 2000, shopify_handle: "rich" })], total: 2, productTypes: [] });
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "Voici.", products: [{ sku: "CHEAP", reason: "a" }, { sku: "RICH", reason: "b" }] }));
    const res = await runAssistant({ message: "un canapé, budget 800$", locale: "fr" });
    expect(res.products.map((p) => p.sku)).toEqual(["CHEAP"]); // cap = 800 * 1.3 = 1040; 2000 is out
  });

  it("keeps everything when the budget would empty the list (close beats nothing)", async () => {
    getProducts.mockResolvedValue({ products: [prod({ sku: "RICH", price: 2000, shopify_handle: "rich" })], total: 1, productTypes: [] });
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "Voici.", products: [{ sku: "RICH", reason: "b" }] }));
    const res = await runAssistant({ message: "un canapé, budget 200$", locale: "fr" });
    expect(res.products).toHaveLength(1);
  });
});

describe("emptyAwareReply", () => {
  it("never promises options when there are none", async () => {
    const { emptyAwareReply } = await import("@/lib/assistant");
    expect(emptyAwareReply("Voici quelques options qui pourraient convenir.", 0, "fr")).toContain("Je n'ai pas trouvé");
    expect(emptyAwareReply("Here are a few options that might fit.", 0, "en")).toContain("couldn't find");
    expect(emptyAwareReply("Voici une option.", 2, "fr")).toBe("Voici une option.");
  });
});

describe("sanitizeShopperText", () => {
  it("strips markup so an echoed reply can never carry an executable tag", async () => {
    const { sanitizeShopperText } = await import("@/app/api/assistant/route");
    expect(sanitizeShopperText("<img src=x onerror=alert(1)> sofa")).toBe("sofa");
    // Inner text survives as INERT plain text — that is correct for a text sanitizer.
    // What must not survive is the markup itself.
    const out = sanitizeShopperText("<script>bad()</script>canape");
    expect(out).not.toMatch(/[<>]/);
    expect(out).toContain("canape");
  });
  it("leaves ordinary shopper text, accents and currency intact", async () => {
    const { sanitizeShopperText } = await import("@/app/api/assistant/route");
    expect(sanitizeShopperText("Je cherche un canape, budget 800$")).toBe("Je cherche un canape, budget 800$");
    expect(sanitizeShopperText("  terrasse 10x10   pieds  ")).toBe("terrasse 10x10 pieds");
  });
});
