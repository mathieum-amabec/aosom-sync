import { describe, it, expect } from "vitest";
import { stripMarkdown } from "@/lib/strip-markdown";

describe("stripMarkdown", () => {
  it("strips **bold** and __bold__ to inner text", () => {
    expect(stripMarkdown("**Promo** du jour et __gros__ rabais")).toBe(
      "Promo du jour et gros rabais",
    );
  });

  it("strips ATX # headers but keeps the heading text", () => {
    expect(stripMarkdown("# Grand titre\nLigne de corps")).toBe("Grand titre\nLigne de corps");
    expect(stripMarkdown("### Sous-titre")).toBe("Sous-titre");
  });

  it("does NOT strip #hashtags (no space after #)", () => {
    expect(stripMarkdown("Du style chez vous\n#Meubles #Patio")).toBe(
      "Du style chez vous\n#Meubles #Patio",
    );
  });

  it("removes --- / *** / ___ horizontal rules", () => {
    expect(stripMarkdown("Avant\n---\nAprès")).toBe("Avant\nAprès");
    expect(stripMarkdown("Avant\n***\nAprès")).toBe("Avant\nAprès");
  });

  it("trims trailing whitespace and collapses blank runs", () => {
    expect(stripMarkdown("Ligne   \n\n\n\nFin   ")).toBe("Ligne\n\nFin");
  });

  it("leaves a clean post (emoji + hashtags) unchanged", () => {
    const clean = "Un meuble qui dure 15 ans. 👇\n\n#AmeubloDirect";
    expect(stripMarkdown(clean)).toBe(clean);
  });

  it("handles the full leaked-markdown shape", () => {
    const dirty = "## Votre espace\n\n☀️ **Le ton** est donné.\n\n---\n\nVotre style? 👇   ";
    expect(stripMarkdown(dirty)).toBe("Votre espace\n\n☀️ Le ton est donné.\n\nVotre style? 👇");
  });
});
