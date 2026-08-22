import { describe, it, expect } from "vitest";
import { stripMarkdown, stripLeadingPlatformLabel, cleanSocialCaption } from "@/lib/strip-markdown";

describe("stripMarkdown", () => {
  it("strips **bold** and __bold__ to inner text", () => {
    expect(stripMarkdown("**Promo** du jour et __gros__ rabais")).toBe(
      "Promo du jour et gros rabais",
    );
  });

  it("strips *italic* single-asterisk emphasis to inner text", () => {
    // The exact artifact that leaked into draft #553's EN caption.
    expect(stripMarkdown("That's exactly why *right now* matters so much.")).toBe(
      "That's exactly why right now matters so much.",
    );
    // Multiple emphases on one line.
    expect(stripMarkdown("*Vraiment* le *bon* moment")).toBe("Vraiment le bon moment");
  });

  it("strips **bold** and *italic* together without eating bold markers (ordering guard)", () => {
    expect(stripMarkdown("**Gros** rabais *vraiment* fou")).toBe("Gros rabais vraiment fou");
  });

  it("leaves a lone unpaired asterisk untouched", () => {
    expect(stripMarkdown("Rabais 50% * conditions")).toBe("Rabais 50% * conditions");
  });

  it("does NOT mangle `* ` bullets across lines (same-line only)", () => {
    // A leading bullet `*` must not pair with the next line's bullet `*`.
    expect(stripMarkdown("* premier item\n* second item")).toBe(
      "* premier item\n* second item",
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

describe("stripLeadingPlatformLabel", () => {
  it("removes a 'Post Facebook 🌿' label line, keeping the hook as the opening", () => {
    expect(stripLeadingPlatformLabel("Post Facebook 🌿\n\nTa terrasse mérite mieux 👇")).toBe(
      "Ta terrasse mérite mieux 👇",
    );
  });

  it("removes a label preceded by leading emoji / decoration (draft #680 shape)", () => {
    // The model wrote "🌿 Post Facebook ⏳ <hook>" — an emoji BEFORE the label, so a
    // whitespace-only anchor (\s*) never reached it and the label leaked into the
    // published caption. The [^\p{L}\p{N}]* anchor skips the leading emoji too.
    expect(
      stripLeadingPlatformLabel("🌿 Post Facebook ⏳ Profitez-en avant que ça parte !"),
    ).toBe("Profitez-en avant que ça parte !");
    expect(stripLeadingPlatformLabel("☀️ Publication Instagram : Découvrez")).toBe("Découvrez");
    // Decoration-only header on its own line, emoji-prefixed → whole line dropped.
    expect(stripLeadingPlatformLabel("🌿 Post Facebook ⏳\nContenu")).toBe("Contenu");
  });

  it("does NOT strip a label that is not the first word (emoji + real word first)", () => {
    // "Post Facebook" appears after a real opening word — that's prose, not a header.
    expect(stripLeadingPlatformLabel("🌿 Salut ! Poste sur Facebook 👇")).toBe(
      "🌿 Salut ! Poste sur Facebook 👇",
    );
  });

  it("removes a decoration-only label header line (all variants → clean body)", () => {
    // Each of these is a pure header: label token + only emoji/`:`/`-`/spaces on
    // its line, real caption below. The whole header line is dropped.
    expect(stripLeadingPlatformLabel("Post Instagram ☀️\nContenu")).toBe("Contenu");
    expect(stripLeadingPlatformLabel("Post IG\nContenu")).toBe("Contenu");
    expect(stripLeadingPlatformLabel("Publication Facebook :\nContenu")).toBe("Contenu");
    expect(stripLeadingPlatformLabel("Facebook Post:\nContenu")).toBe("Contenu");
    // Short-form "<Platform> Post" labels are stripped on both branches.
    expect(stripLeadingPlatformLabel("FB Post\nContenu")).toBe("Contenu");
    expect(stripLeadingPlatformLabel("IG Post —\nContenu")).toBe("Contenu");
  });

  it("eats leading blank lines before the label", () => {
    expect(stripLeadingPlatformLabel("\n\nPost Facebook 🌿\nContenu")).toBe("Contenu");
  });

  it("keeps inline content after the label instead of eating the whole line", () => {
    // The model wrote the label AHEAD of the real hook on line 1, with a body
    // below. Only the label token + separator is dropped — the hook survives.
    // (A greedy whole-line strip here would silently delete the hook on the
    // unreviewed reel publish path.)
    expect(
      stripLeadingPlatformLabel("Publication Instagram : Découvrez nos supports muraux !\n\nLivraison gratuite 🌿"),
    ).toBe("Découvrez nos supports muraux !\n\nLivraison gratuite 🌿");
    // Only the leading "<platform> post" token is removed from a prose opener,
    // not the sentence after it.
    expect(
      stripLeadingPlatformLabel("Instagram post reach dropped 40%\nVoici pourquoi 👇"),
    ).toBe("reach dropped 40%\nVoici pourquoi 👇");
  });

  it("leaves a real marketing hook untouched (no label)", () => {
    const hook = "☀️ Ta terrasse de rêve t'attend...\n\nDécouvre la collection 👇";
    expect(stripLeadingPlatformLabel(hook)).toBe(hook);
    // A hook that merely mentions Facebook mid-sentence is not a label line.
    expect(stripLeadingPlatformLabel("Partage sur Facebook ce que tu aimes 👇")).toBe(
      "Partage sur Facebook ce que tu aimes 👇",
    );
  });

  it("strips the EN preamble form ('This is your Facebook post', 'Here's your …')", () => {
    // The English generator sometimes prepends "This is your <platform> post" —
    // an EN preamble in front of the "<Platform> post" label. Strip it like any
    // other leading label, keeping the hook.
    expect(
      stripLeadingPlatformLabel("This is your Facebook post 🌿\n\nTa terrasse mérite mieux 👇"),
    ).toBe("Ta terrasse mérite mieux 👇");
    expect(stripLeadingPlatformLabel("This is your Instagram post: Discover our sofas!")).toBe(
      "Discover our sofas!",
    );
    expect(stripLeadingPlatformLabel("Here's your Facebook post\nContent")).toBe("Content");
    expect(stripLeadingPlatformLabel("Here is your Instagram post —\nContent")).toBe("Content");
    expect(stripLeadingPlatformLabel("Below is your FB post\nContent")).toBe("Content");
    // Label-only EN preamble generation → "" (the correct reject/fallback signal).
    expect(stripLeadingPlatformLabel("This is your Facebook post")).toBe("");
  });

  it("does NOT strip an EN preamble that isn't followed by a platform label", () => {
    // "This is your …" only strips when a platform label immediately follows it.
    // A real opener that happens to start the same way must survive untouched.
    const a = "This is your chance to refresh the patio 👇";
    expect(stripLeadingPlatformLabel(a)).toBe(a);
    const b = "Here's your weekend project: a cozy reading nook 📚";
    expect(stripLeadingPlatformLabel(b)).toBe(b);
  });
});

describe("cleanSocialCaption", () => {
  it("strips a markdown-titled platform label (# / **) — order matters", () => {
    // The label is wrapped in Markdown, so it survives stripLeadingPlatformLabel
    // alone; cleanSocialCaption strips Markdown FIRST, then the bare label line.
    expect(cleanSocialCaption("# Post Facebook 🌿\n\nTa terrasse mérite mieux 👇")).toBe(
      "Ta terrasse mérite mieux 👇",
    );
    expect(cleanSocialCaption("**Post Facebook 🌿**\n\nTa terrasse mérite mieux 👇")).toBe(
      "Ta terrasse mérite mieux 👇",
    );
  });

  it("strips both Markdown and a plain leading label together", () => {
    expect(cleanSocialCaption("Post Instagram ☀️\n\n**Gros** rabais *fou* 👇")).toBe(
      "Gros rabais fou 👇",
    );
  });

  it("returns '' for a degenerate label-only generation (never re-adds the label)", () => {
    // If the whole caption is just the label, the RIGHT answer is empty — callers
    // reject/fall back on empty (reel keeps original, route 502s). Returning the
    // bare label would re-publish the exact prefix we exist to strip.
    expect(cleanSocialCaption("# Post Facebook 🌿")).toBe("");
    expect(cleanSocialCaption("**Post Facebook 🌿**")).toBe("");
    expect(cleanSocialCaption("Post Facebook 🌿")).toBe("");
  });

  it("keeps same-line content after an inline label (single-line generation)", () => {
    // The model put the label and the real hook on ONE line. Strip only the
    // label + its separator, KEEP the hook — do not swallow the whole line
    // (which previously made the empty-fallback re-add the label).
    expect(cleanSocialCaption("Publication Instagram: Découvrez notre canapé 🌿")).toBe(
      "Découvrez notre canapé 🌿",
    );
    expect(cleanSocialCaption("Facebook Post — Ta terrasse mérite mieux 👇")).toBe(
      "Ta terrasse mérite mieux 👇",
    );
  });

  it("strips an EN-preamble label, including its markdown-titled form", () => {
    expect(cleanSocialCaption("**This is your Facebook post 🌿**\n\nYour patio deserves better 👇")).toBe(
      "Your patio deserves better 👇",
    );
    expect(cleanSocialCaption("This is your Instagram post: Discover our wall shelves 🌿")).toBe(
      "Discover our wall shelves 🌿",
    );
    // Label-only EN preamble → "" (callers reject/fall back; never re-publish the label).
    expect(cleanSocialCaption("# This is your Facebook post 🌿")).toBe("");
  });

  it("leaves a clean caption unchanged", () => {
    const clean = "Un meuble qui dure 15 ans. 👇\n\n#AmeubloDirect";
    expect(cleanSocialCaption(clean)).toBe(clean);
  });
});
