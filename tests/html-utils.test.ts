import { describe, it, expect } from "vitest";
import { stripLeadingHeading } from "@/lib/html-utils";

describe("stripLeadingHeading", () => {
  it("strips a leading <h2>", () => {
    expect(stripLeadingHeading("<h2>Titre marketing</h2><p>Corps.</p>")).toBe("<p>Corps.</p>");
  });

  it("strips a leading <h3> and <h1>", () => {
    expect(stripLeadingHeading("<h3>Slogan</h3><p>x</p>")).toBe("<p>x</p>");
    expect(stripLeadingHeading("<h1>Titre</h1><p>x</p>")).toBe("<p>x</p>");
  });

  it("tolerates attributes and leading whitespace", () => {
    expect(stripLeadingHeading('  <h2 class="x">A</h2>\n<p>B</p>')).toBe("<p>B</p>");
  });

  it("keeps the rest of the description intact", () => {
    const html = "<h2>Intro</h2><p>Un</p><h2>Section</h2><p>Deux</p>";
    expect(stripLeadingHeading(html)).toBe("<p>Un</p><h2>Section</h2><p>Deux</p>");
  });

  it("is idempotent (no leading heading → unchanged)", () => {
    const html = "<p>Déjà propre.</p><h2>Mid</h2>";
    expect(stripLeadingHeading(html)).toBe(html);
    expect(stripLeadingHeading(stripLeadingHeading("<h2>A</h2><p>B</p>"))).toBe("<p>B</p>");
  });

  it("does not strip a heading that isn't at the very start", () => {
    const html = "<p>Lead</p><h2>Section</h2>";
    expect(stripLeadingHeading(html)).toBe(html);
  });

  it("only removes ONE leading heading (matching close tag)", () => {
    // mismatched levels: <h2>…</h3> must NOT be greedily removed
    expect(stripLeadingHeading("<h2>A</h2><h3>B</h3><p>C</p>")).toBe("<h3>B</h3><p>C</p>");
  });

  it("handles null/undefined/empty", () => {
    expect(stripLeadingHeading(null)).toBe("");
    expect(stripLeadingHeading(undefined)).toBe("");
    expect(stripLeadingHeading("")).toBe("");
  });
});
