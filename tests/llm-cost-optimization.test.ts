import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Guards for the two LLM cost optimizations:
 *
 *   1. The batch pool runs on the cheap model, the customer-facing assistant does not.
 *      Haiku 4.5 is exactly 1/3 of Sonnet 4.6 on both input and output, so this is a
 *      flat two-thirds cut on the batch pool regardless of the input/output mix.
 *   2. Product content is generated ONCE per PSIN group: `mergeVariants` already folds a
 *      group's colour/size variants into one merged product, and `generateContent` now
 *      reuses a job's stored content instead of paying for near-identical copy again.
 *
 * The escalation path is what makes (1) safe: a cheap-model response that fails the
 * schema checks is re-run on the assistant-grade model, so cost degrades, not quality.
 */

vi.mock("@/lib/config", () => ({
  env: { anthropicApiKey: "test-key" },
  CLAUDE: { MODEL: "model-strong", MODEL_BATCH: "model-cheap", MAX_TOKENS_CONTENT: 1000 },
}));

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

// budgetedCreate is exercised in llm-budget.test.ts; here it must stay a thin pass-through
// so the assertions below see the exact `model` each caller asked for.
vi.mock("@/lib/llm-budget", () => ({
  budgetedCreate: async (client: { messages: { create: (p: unknown) => unknown } }, params: unknown) =>
    client.messages.create(params),
}));

const { generateProductContent, ContentValidationError } = await import("@/lib/content-generator");

function validPayload(titleFr = "Chaise longue") {
  return JSON.stringify({
    titleFr,
    titleEn: "Lounge chair",
    descriptionFr: "<p>fr</p>",
    descriptionEn: "<p>en</p>",
    seoDescriptionFr: "desc fr",
    seoDescriptionEn: "desc en",
    metaTitleFr: "m fr | Livraison gratuite — Ameublo Direct",
    metaTitleEn: "m en | Free Shipping — Furnish Direct",
    metaDescriptionFr: "md fr",
    metaDescriptionEn: "md en",
    urlHandleFr: "chaise-longue",
    urlHandleEn: "lounge-chair",
    tags: ["chaise"],
  });
}

const textReply = (text: string) => ({ content: [{ type: "text", text }] });

function makeProduct() {
  return {
    name: "Chaise longue grise",
    description: "<p>Une chaise.</p>",
    shortDescription: "<p>Court.</p>",
    brand: "Outsunny",
    productType: "Chaise",
    material: "Acier",
    // Two colourways of ONE PSIN group — both are covered by a single generation.
    variants: [
      { sku: "ABC-GY", price: 99 },
      { sku: "ABC-BK", price: 99 },
    ],
  } as never;
}

beforeEach(() => create.mockReset());

describe("batch model selection", () => {
  it("generates product content on the cheap batch model, not the assistant model", async () => {
    create.mockResolvedValue(textReply(validPayload()));
    await generateProductContent(makeProduct());
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].model).toBe("model-cheap");
  });

  it("covers every variant of the PSIN group in that single call", async () => {
    create.mockResolvedValue(textReply(validPayload()));
    await generateProductContent(makeProduct());
    const prompt = create.mock.calls[0][0].messages[0].content as string;
    // Both colourways ride along in one prompt — there is no second call to cache away.
    expect(prompt).toContain("ABC-GY");
    expect(prompt).toContain("ABC-BK");
  });
});

describe("quality guard: escalation to the assistant-grade model", () => {
  it("re-runs on the strong model when the cheap model returns unparseable JSON", async () => {
    create
      .mockResolvedValueOnce(textReply("sorry, here is some prose instead of JSON"))
      .mockResolvedValueOnce(textReply(validPayload("Chaise longue")));

    const out = await generateProductContent(makeProduct());

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].model).toBe("model-cheap");
    expect(create.mock.calls[1][0].model).toBe("model-strong");
    expect(out.titleFr).toBe("Chaise longue");
  });

  it("re-runs when the cheap model omits a required field", async () => {
    const missingField = JSON.parse(validPayload());
    delete missingField.metaDescriptionEn;
    create
      .mockResolvedValueOnce(textReply(JSON.stringify(missingField)))
      .mockResolvedValueOnce(textReply(validPayload()));

    await generateProductContent(makeProduct());
    expect(create.mock.calls[1][0].model).toBe("model-strong");
  });

  it("does NOT escalate on a non-validation failure — a network blip must not buy a 2nd call", async () => {
    // mockRejectedValueOnce (the pattern used elsewhere in this suite): a persistent
    // rejected mock leaves an un-consumed rejected promise that vitest flags as unhandled.
    create.mockRejectedValueOnce(new Error("socket hang up"));
    let caught: unknown;
    try {
      await generateProductContent(makeProduct());
    } catch (err) {
      caught = err;
    }
    expect((caught as Error | undefined)?.message).toBe("socket hang up");
    expect(caught).not.toBeInstanceOf(ContentValidationError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("gives up rather than looping when the strong model also fails validation", async () => {
    create.mockResolvedValue(textReply("not json"));
    await expect(generateProductContent(makeProduct())).rejects.toBeInstanceOf(ContentValidationError);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe("model routing is enforced across the codebase, not just at the call sites tested above", () => {
  // A new caller that copies an existing snippet would silently put batch work back on
  // Sonnet and quietly undo the saving. Pin the rule instead of trusting convention.

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p);
    }
    return out;
  }

  const srcFiles = walk(path.join(process.cwd(), "src"));

  it("uses CLAUDE.MODEL only in the customer-facing assistant", () => {
    const offenders = srcFiles.filter((f) => {
      if (f.endsWith(path.join("lib", "assistant.ts")) || f.endsWith(path.join("lib", "config.ts"))) return false;
      return /model:\s*CLAUDE\.MODEL\s*,/.test(fs.readFileSync(f, "utf8"));
    });
    expect(offenders.map((f) => path.relative(process.cwd(), f))).toEqual([]);
  });

  it("routes every Claude call through budgetedCreate so nothing escapes the daily cap", () => {
    // blog-generator.ts bypassed this before v0.5.64.0 — neither capped nor counted.
    const offenders = srcFiles.filter((f) => {
      if (f.endsWith(path.join("lib", "llm-budget.ts"))) return false;
      // Match CODE only. The blog-generator comment that documents this very rule names
      // the call, and a naive regex hits the comment — the same trap that made an earlier
      // CSP test pass with no directive present.
      return fs
        .readFileSync(f, "utf8")
        .split("\n")
        .some((line) => {
          const t = line.trim();
          if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
          return /client\.messages\.create\(/.test(t);
        });
    });
    expect(offenders.map((f) => path.relative(process.cwd(), f))).toEqual([]);
  });
});
