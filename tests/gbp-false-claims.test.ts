import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/config", () => ({ env: {}, CLAUDE: { MODEL_BATCH: "claude-cheap", MODEL: "claude-strong" }, SHOPIFY: {} }));

const { findGbpFalseClaim } = await import("@/lib/gbp-post-generator");

describe("findGbpFalseClaim — Ameublo Direct is an online store", () => {
  it.each([
    ["Passez à notre boutique ce week-end", "boutique"],
    ["Venez nous voir en magasin", "venez nous voir"],
    ["Dernière chance pour profiter de ce fauteuil", "Dernière chance"],
    ["Stock limité, réservez vite", "Stock limité"],
  ])("flags %s", (text, hit) => {
    expect(findGbpFalseClaim(text)?.toLowerCase()).toContain(hit.toLowerCase());
  });
  it("lets an honest online post through", () => {
    expect(findGbpFalseClaim("Un fauteuil confortable, livré gratuitement partout au Canada. Commandez sur ameublodirect.ca.")).toBeNull();
  });
});
