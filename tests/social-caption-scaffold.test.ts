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

  it("strips *italic* emphasis that LLMs leak into captions", () => {
    // Draft #553 (EN) shipped "*right now*" verbatim before this strip existed.
    expect(
      stripScaffold("You waited 8 months — that's exactly why *right now* matters."),
    ).toBe("You waited 8 months — that's exactly why right now matters.");
  });

  it("strips a leading 'Post Facebook 🌿' platform-label title", () => {
    expect(stripScaffold("Post Facebook 🌿\n\nTa terrasse mérite mieux 👇")).toBe(
      "Ta terrasse mérite mieux 👇",
    );
    // Even combined with a conversational preamble on the line above.
    expect(stripScaffold("Here's a Facebook post:\nPost Instagram ☀️\nContenu 👇")).toBe(
      "Contenu 👇",
    );
  });

  it("strips a markdown-titled platform label (# Post Facebook 🌿)", () => {
    // stripScaffold now routes through cleanSocialCaption: Markdown is stripped
    // FIRST, so the `#`/`**`-wrapped label reduces to a bare label line and is
    // removed instead of publishing "Post Facebook 🌿" as the opening line.
    expect(stripScaffold("# Post Facebook 🌿\n\nTa terrasse mérite mieux 👇")).toBe(
      "Ta terrasse mérite mieux 👇",
    );
    expect(stripScaffold("**Post Facebook 🌿**\n\nTa terrasse mérite mieux 👇")).toBe(
      "Ta terrasse mérite mieux 👇",
    );
  });

  it("leaves an already-clean post unchanged", () => {
    const clean =
      "Un meuble qui dure 15 ans coûte moins cher qu'un meuble qui dure 3.\n\n" +
      "Et vous, quel est votre choix? 👇";
    expect(stripScaffold(clean)).toBe(clean);
  });
});
