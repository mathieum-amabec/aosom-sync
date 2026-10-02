import { describe, it, expect, vi, beforeEach } from "vitest";

// The assistant runs on Gemini since 2026-10-02 (gemini-client.ts). Mock config (no env).
vi.mock("@/lib/config", () => ({
  env: { geminiApiKey: "test-key" },
  GEMINI: { MODEL_ASSISTANT: "gemini-3.5-flash-lite", MODEL_VIDEO_QC: "gemini-3.5-flash-lite" },
}));

// geminiGenerate wraps the HTTP call with the daily-budget guard; delegate to `create` so these
// tests exercise the tool loop, not the budget bookkeeping. create.mock.calls[n][0] = params.
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/gemini-client", () => ({ geminiGenerate: (params: unknown) => create(params) }));

const getProducts = vi.fn();
const getComplementaryProducts = vi.fn();
const getComplementaryCandidates = vi.fn();
const getProduct = vi.fn();
vi.mock("@/lib/database", () => ({ getProducts, getProduct, getComplementaryProducts, getComplementaryCandidates }));

// FR-title resolution calls shopifyFetch(/graphql.json). Mock it; default = no match
// (so cards fall back to the catalog name unless a test opts into FR titles).
const shopifyFetch = vi.fn();
vi.mock("@/lib/shopify-client", () => ({ shopifyFetch }));

const { runAssistant, runComplementary, pickComplementary, stripMarkdown } = await import("@/lib/assistant");

const prod = (over: Partial<Record<string, unknown>> = {}) => ({
  sku: "A-1", name: "Sofa sectionnel", price: 499, qty: 5, color: "Gris",
  product_type: "Sofas", image1: "https://img/1.jpg",
  shopify_product_id: "111", shopify_handle: "sofa-sectionnel-gris", ...over,
});
const toolUse = (input: unknown, name = "search_catalog") => ({
  functionCalls: [{ name, args: input, id: "t1" }],
  content: { role: "model", parts: [{ functionCall: { name, args: input, id: "t1" }, thoughtSignature: "sig" }] },
  text: "",
});
const textReply = (text: string) => ({ functionCalls: [], content: { role: "model", parts: [{ text }] }, text });
const final = (obj: unknown) => textReply(JSON.stringify(obj));
type Turn = { role: string; parts: Array<{ text?: string; functionResponse?: { response: { result: unknown } } }> };

beforeEach(() => {
  create.mockReset();
  getComplementaryCandidates.mockReset().mockResolvedValue([]);
  getProducts.mockReset().mockResolvedValue({ products: [prod()], total: 1, productTypes: [] });
  getComplementaryProducts.mockReset().mockResolvedValue([]);
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

  it("sends every turn on the Gemini assistant model", async () => {
    // The saving is only real if EVERY call in the loop uses GEMINI.MODEL_ASSISTANT.
    create.mockResolvedValueOnce(toolUse({ query: "table" })).mockResolvedValueOnce(final({ reply: "ok", products: [] }));
    await runAssistant({ message: "une table", locale: "fr" });
    expect(create).toHaveBeenCalledTimes(2);
    for (const call of create.mock.calls) {
      expect(call[0].model).toBe("gemini-3.5-flash-lite");
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
    const sent = create.mock.calls[0][0].contents as Turn[];
    // history turns must precede the latest user message, in order; assistant turns are "model".
    expect(sent.map((m) => m.role)).toEqual(["user", "model", "user", "user"]);
    expect(sent.map((m) => m.parts[0].text)).toEqual([
      "je cherche un canapé pour un petit salon",
      "Voici quelques options.",
      "j'ai un budget de 500$",
      "je préfère le gris",
    ]);
  });

  it("system prompt distinguishes indoor vs outdoor and instructs multi-turn refinement", async () => {
    create.mockResolvedValueOnce(final({ reply: "ok", products: [] }));
    await runAssistant({ message: "un canapé pour mon salon", locale: "fr" });
    const system = create.mock.calls[0][0].systemInstruction as string;
    expect(system).toMatch(/INDOOR vs OUTDOOR/);
    expect(system).toMatch(/patio|outdoor/i);
    expect(system).toMatch(/refine|accumulated|maxPrice/i);
  });

  it("declares the three tools on every non-final turn and tells the model the catalog is in English", async () => {
    create.mockResolvedValueOnce(toolUse({ query: "table" })).mockResolvedValueOnce(final({ reply: "ok", products: [] }));
    await runAssistant({ message: "une table", locale: "fr" });
    for (const call of create.mock.calls) {
      expect((call[0].tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["search_catalog", "recommend_complementary_products", "get_store_info", "get_product_details"]);
    }
    // Gemini searched "sofa gris" verbatim and found nothing (2026-10-02).
    expect(create.mock.calls[0][0].systemInstruction).toMatch(/indexed in ENGLISH/);
  });

  it("pushes the model's function-call turn back verbatim (Gemini 3 thought signatures)", async () => {
    create.mockResolvedValueOnce(toolUse({ query: "sofa" })).mockResolvedValueOnce(final({ reply: "ok", products: [] }));
    await runAssistant({ message: "canapé", locale: "fr" });
    const second = create.mock.calls[1][0].contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(second[1]).toEqual({ role: "model", parts: [{ functionCall: { name: "search_catalog", args: { query: "sofa" }, id: "t1" }, thoughtSignature: "sig" }] });
    expect(second[2].parts[0].functionResponse).toMatchObject({ name: "search_catalog", id: "t1" });
  });

  it("relaxes a multi-word search that finds nothing to its single words", async () => {
    // "grey sofa" → 0 rows in production (the colour is its own column); "sofa" → many.
    getProducts.mockImplementation(async (f: { search?: string }) =>
      f.search === "sofa" ? { products: [prod()], total: 1, productTypes: [] } : { products: [], total: 0, productTypes: [] },
    );
    create
      .mockResolvedValueOnce(toolUse({ query: "grey velvet sofa" }))
      .mockResolvedValueOnce(final({ reply: "ok", products: [{ sku: "A-1", reason: "x" }] }));
    const res = await runAssistant({ message: "canapé gris", locale: "fr" });
    expect(res.products.map((p) => p.sku)).toEqual(["A-1"]);
    // Colour words are stripped from the text search; the category/colour never hit SQL.
    const searches = getProducts.mock.calls.map((c) => c[0].search);
    expect(searches[0]).toBe("velvet sofa");
    for (const c of getProducts.mock.calls) {
      expect(c[0].productType).toBeUndefined();
      expect(c[0].color).toBeUndefined();
    }
  });

  it("ranks the asked colour first, translating it FR→EN", async () => {
    getProducts.mockResolvedValue({
      products: [prod({ sku: "B-1", color: "Black" }), prod({ sku: "G-1", color: "Grey" })],
      total: 2,
      productTypes: [],
    });
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa", color: "Gris" }))
      .mockResolvedValueOnce(final({ reply: "ok", products: [] }));
    await runAssistant({ message: "canapé gris", locale: "fr" });
    const second = create.mock.calls[1][0].contents as Turn[];
    const result = second[2].parts[0].functionResponse!.response.result as Array<{ sku: string }>;
    expect(result.map((r) => r.sku)).toEqual(["G-1", "B-1"]);
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
    // Twice since 2026-10-02: search results are live-checked before the model sees them,
    // and the final cards once more (FR title + a product unpublished in between).
    expect(shopifyFetch).toHaveBeenCalledTimes(2);
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

  it("withholds the tools on the last step so the model has to answer", async () => {
    // Gemini kept searching through all 3 steps and shoppers got the salvage reply (2026-10-02).
    create.mockResolvedValue(toolUse({ query: "sofa" }));
    await runAssistant({ message: "canapé", locale: "fr" });
    expect(create).toHaveBeenCalledTimes(5);
    expect(create.mock.calls[0][0].tools).toHaveLength(4);
    expect(create.mock.calls[4][0].tools).toBeUndefined();
    expect(create.mock.calls[4][0].systemInstruction).toMatch(/NO MORE SEARCHES/);
  });

  it("get_product_details reads the live page of a product from the pool, never an unknown sku", async () => {
    shopifyFetch.mockImplementation(async (url: string) =>
      url.startsWith("/products.json")
        ? { ok: true, json: async () => ({ products: [{ id: 9, title: "Sofa gris", body_html: "<p>Largeur : 84 po</p>", options: [{ name: "Couleur", values: ["Gris"] }], variants: [{ title: "Gris", price: "499.00" }] }] }) }
        : { ok: true, json: async () => ({ data: { products: { nodes: [] } } }) },
    );
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(toolUse({ sku: "A-1" }, "get_product_details"))
      .mockResolvedValueOnce(final({ reply: "Il fait 84 po.", products: [{ sku: "A-1", reason: "x" }] }));
    await runAssistant({ message: "un sofa pour un mur de 9 pi", locale: "fr" });
    const third = create.mock.calls[2][0].contents as Turn[];
    const details = third[4].parts[0].functionResponse!.response.result as { description: string; options: string[] };
    expect(details.description).toContain("84 po");
    expect(details.options).toEqual(["Couleur: Gris"]);
    expect(shopifyFetch.mock.calls.some((c) => String(c[0]).includes("handle=sofa-sectionnel-gris"))).toBe(true);
  });

  it("adds the server-computed total under a room-in-a-budget answer", async () => {
    getProducts.mockResolvedValue({
      products: [prod({ sku: "S-1", price: 400 }), prod({ sku: "T-1", price: 99.5, shopify_handle: "table" })],
      total: 2,
      productTypes: [],
    });
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "Voici votre salon.", products: [{ sku: "S-1", reason: "" }, { sku: "T-1", reason: "" }] }));
    const res = await runAssistant({ message: "un salon complet pour 1200$", locale: "fr" });
    // fr-CA formatting uses (narrow) no-break spaces, which \s matches.
    expect(res.reply).toMatch(/\nTotal : 499,50\s\$ \(budget : 1\s200,00\s\$\)$/);
  });

  it("answers a policy question from get_store_info and keeps the reply even with no products", async () => {
    create
      .mockResolvedValueOnce(toolUse({ question: "délai de retour" }, "get_store_info"))
      .mockResolvedValueOnce(final({ reply: "Vous avez 30 jours pour retourner un article.", products: [], flag: null }));
    const res = await runAssistant({ message: "Je peux retourner un article?", locale: "fr" });
    expect(res.reply).toBe("Vous avez 30 jours pour retourner un article.");
    expect(res.products).toEqual([]);
    expect(getProducts).not.toHaveBeenCalled();
  });

  it("reports tokens and the model's abuse flag in meta (stripped by the route)", async () => {
    create.mockResolvedValueOnce({ ...final({ reply: "Je ne peux pas faire ça.", products: [], flag: "off_topic" }), usage: { totalTokenCount: 1234 } });
    const res = await runAssistant({ message: "écris-moi un poème", locale: "fr" });
    expect(res.meta).toEqual({ tokens: 1234, flag: "off_topic" });
  });

  it("names the persona per locale", async () => {
    create.mockResolvedValue(final({ reply: "ok", products: [] }));
    await runAssistant({ message: "allo", locale: "fr" });
    await runAssistant({ message: "hi", locale: "en" });
    expect(create.mock.calls[0][0].systemInstruction).toMatch(/You are Ameublo, .* Ameublo Direct/);
    expect(create.mock.calls[1][0].systemInstruction).toMatch(/You are Furni, .* Furnish Direct/);
  });

  it("falls back from a 3-word phrase to 2-word sub-phrases before single words", async () => {
    getProducts.mockImplementation(async (f: { search?: string }) =>
      f.search === "fire pit" ? { products: [prod()], total: 1, productTypes: [] } : { products: [], total: 0, productTypes: [] },
    );
    create
      .mockResolvedValueOnce(toolUse({ query: "outdoor fire pit" }))
      .mockResolvedValueOnce(final({ reply: "ok", products: [{ sku: "A-1", reason: "x" }] }));
    await runAssistant({ message: "foyer extérieur", locale: "fr" });
    const searches = [...new Set(getProducts.mock.calls.map((c) => c[0].search))];
    expect(searches).toEqual(["outdoor fire pit", "fire pit"]);
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
      .mockResolvedValueOnce(textReply("désolé, je ne peux pas"));
    const res = await runAssistant({ message: "canapé", locale: "fr" });
    expect(res.products).toHaveLength(0);
    expect(typeof res.reply).toBe("string");
  });

  it("caps the search filters and only sends compact rows to the model", async () => {
    create
      .mockResolvedValueOnce(toolUse({ query: "sofa" }))
      .mockResolvedValueOnce(final({ reply: "ok", products: [{ sku: "A-1", reason: "x" }] }));
    await runAssistant({ message: "canapé", locale: "fr" });
    // The function response handed back to the model must NOT leak internal fields (handle/image).
    const second = create.mock.calls[1][0].contents as Turn[];
    const toolTurn = second.find((m) => m.role === "user" && m.parts[0].functionResponse);
    const payload = toolTurn!.parts[0].functionResponse!.response.result as Array<Record<string, unknown>>;
    expect(payload[0]).toHaveProperty("sku");
    expect(payload[0]).not.toHaveProperty("handle");
    expect(payload[0]).not.toHaveProperty("image");
  });

  it("routes a recommend_complementary_products tool call to getComplementaryProducts, not getProducts", async () => {
    getComplementaryProducts.mockResolvedValueOnce([
      { sku: "RUG-1", name: "Tapis gris", price: 89, qty: 3, image1: "https://img/rug.jpg", shopify_handle: "tapis-gris", product_type: "Area Rugs", color: "Gris" },
    ]);
    create
      .mockResolvedValueOnce(toolUse({ baseSku: "A-1", productType: "Area Rugs" }, "recommend_complementary_products"))
      .mockResolvedValueOnce(final({ reply: "Pour compléter votre salon :", products: [{ sku: "RUG-1", reason: "S'agence avec le gris" }] }));

    const res = await runAssistant({ message: "je prends le canapé A-1", locale: "fr" });

    expect(getComplementaryProducts).toHaveBeenCalledWith(
      expect.objectContaining({ excludeSku: "A-1", productType: "Area Rugs" }),
    );
    expect(getProducts).not.toHaveBeenCalled();
    expect(res.products).toHaveLength(1);
    expect(res.products[0]).toMatchObject({ sku: "RUG-1", reason: "S'agence avec le gris" });
  });
});

describe("stripMarkdown (the widget renders textContent)", () => {
  it("turns Markdown links and bold into plain text", () => {
    expect(stripMarkdown("Voir notre [politique de retour](https://ameublodirect.ca/pages/politique-de-retour)."))
      .toBe("Voir notre politique de retour : https://ameublodirect.ca/pages/politique-de-retour.");
    expect(stripMarkdown("C'est **gratuit**.")).toBe("C'est gratuit.");
    expect(stripMarkdown("Rien à changer : https://x.ca")).toBe("Rien à changer : https://x.ca");
  });
});

describe("runComplementary (no LLM since 2026-10-02)", () => {
  const row = (sku: string, type: string) => ({
    sku, name: sku, price: 50, qty: 3, image1: "https://img/x.jpg", shopify_handle: `h-${sku}`, product_type: type, color: "",
  });
  const L = "Home Furnishings > Living Room Furniture";

  it("never calls the model and fills 3 cards from different categories of the same room", async () => {
    getComplementaryCandidates.mockResolvedValue([
      row("CT-1", `${L} > Coffee Tables`), row("CT-2", `${L} > Coffee Tables`),
      row("RUG-1", `${L} > Area Rugs`), row("TV-1", `${L} > TV Stands`), row("LMP-1", `${L} > Floor Lamps`),
    ]);
    const res = await runComplementary({ name: "Canapé gris", productType: `${L} > Sofas`, locale: "fr" });
    expect(create).not.toHaveBeenCalled();
    expect(res.products).toHaveLength(3);
    const types = res.products.map((p) => p.sku.split("-")[0]);
    expect(new Set(types).size).toBe(3);
    expect(res.reply).toBe("");
    expect(getComplementaryCandidates).toHaveBeenCalledWith({ scope: L, exclude: `${L} > Sofas`, limit: 80 });
  });

  it("drops candidates of the same kind even under a differently named leaf", async () => {
    getComplementaryCandidates.mockResolvedValue([
      row("S-1", `${L} > Sofas & Reclining Chairs`), row("S-2", `${L} > 2-Seater Sofas`),
      row("CT-1", `${L} > Coffee Tables`),
    ]);
    const res = await runComplementary({ name: "Canapé", productType: `${L} > Sofas`, locale: "fr" });
    expect(res.products.map((p) => p.sku)).toEqual(["CT-1"]);
  });

  it("widens from the room to the top-level branch when the room is thin", async () => {
    getComplementaryCandidates.mockResolvedValueOnce([row("CT-1", `${L} > Coffee Tables`)]).mockResolvedValueOnce([]);
    await runComplementary({ name: "Canapé", productType: `${L} > Sofas`, locale: "fr" });
    expect(getComplementaryCandidates.mock.calls.map((c) => c[0].scope)).toEqual([L, "Home Furnishings"]);
  });

  it("returns nothing for an empty product type", async () => {
    const res = await runComplementary({ name: "x", productType: "  ", locale: "fr" });
    expect(res.products).toEqual([]);
    expect(getComplementaryCandidates).not.toHaveBeenCalled();
  });

  it("pickComplementary is stable per product and varies across products", () => {
    const rows = ["A", "B", "C", "D", "E", "F"].map((t) => row(t, `${L} > ${t}`));
    const a1 = pickComplementary(rows, "produit-1").map((r) => r.sku);
    expect(pickComplementary(rows, "produit-1").map((r) => r.sku)).toEqual(a1);
    const others = ["produit-2", "produit-3", "produit-4", "produit-5"].map((s) => pickComplementary(rows, s).map((r) => r.sku).join());
    expect(others.some((o) => o !== a1.join())).toBe(true);
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
