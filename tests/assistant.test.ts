import { describe, it, expect, vi, beforeEach } from "vitest";

// config is read at module load via content-generator; mock it (no real env needed).
vi.mock("@/lib/config", () => ({
  env: { anthropicApiKey: "test-key" },
  CLAUDE: { MODEL: "claude-sonnet-4-6", MAX_TOKENS_CONTENT: 1000, MAX_TOKENS_SOCIAL: 500 },
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

  it("uses the EN store domain for locale=en", async () => {
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "Here you go.", products: [{ sku: "A-1", reason: "Comfy" }] }));
    const res = await runAssistant({ message: "I need a sofa", locale: "en" });
    expect(res.products[0].url).toBe("https://furnishdirect.ca/products/sofa-sectionnel-gris");
  });

  it("swaps the raw EN catalog name for the curated Shopify FR title on locale=fr", async () => {
    shopifyFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { products: { nodes: [{ handle: "sofa-sectionnel-gris", title: "Canapé sectionnel gris moderne" }] } } }),
    });
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "ok", products: [{ sku: "A-1", reason: "x" }] }));
    const res = await runAssistant({ message: "canapé", locale: "fr" });
    expect(res.products[0].name).toBe("Canapé sectionnel gris moderne");
  });

  it("does NOT fetch FR titles for locale=en (keeps the catalog/EN name)", async () => {
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "ok", products: [{ sku: "A-1", reason: "x" }] }));
    const res = await runAssistant({ message: "I need a sofa", locale: "en" });
    expect(shopifyFetch).not.toHaveBeenCalled();
    expect(res.products[0].name).toBe("Sofa sectionnel");
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
