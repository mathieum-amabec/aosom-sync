import { describe, it, expect } from "vitest";
import { stripScaffold } from "@/app/api/social/content/generate/route";

describe("stripScaffold", () => {
  it("strips LLM scaffolding (preamble + --- rule + **bold**) into a clean post", () => {
    // The exact shape that leaked into publication_queue for the furnish/EN caption.
    const dirty =
      "Here's a Facebook post for your product:\n\n---\n\n" +
      "☀️ **Your space sets the tone** for everything.\n\n\n\n" +
      "What's your style? 👇";

    const clean = stripScaffold(dirty);

    expect(clean).toBe(
      "☀️ Your space sets the tone for everything.\n\nWhat's your style? 👇",
    );
    // And the specific scaffolding markers are gone.
    expect(clean).not.toMatch(/here'?s\s+a\s+facebook\s+post/i);
    expect(clean).not.toContain("---");
    expect(clean).not.toContain("**");
    expect(clean).not.toMatch(/\n{3,}/);
  });

  it("also strips the 'Here is a' and 'Sure, here's' preamble variants", () => {
    expect(stripScaffold("Here is a fun post:\nReal content")).toBe("Real content");
    expect(stripScaffold("Sure! Here's the caption:\nReal content")).toBe("Real content");
  });

  it("leaves an already-clean post unchanged", () => {
    const clean =
      "Un meuble qui dure 15 ans coûte moins cher qu'un meuble qui dure 3.\n\n" +
      "Et vous, quel est votre choix? 👇";
    expect(stripScaffold(clean)).toBe(clean);
  });
});
