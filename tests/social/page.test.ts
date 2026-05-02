/**
 * Unit tests for Bug B — published draft UX logic.
 *
 * Tests the pure helper functions mirrored from page.tsx.
 * DOM rendering tests are not included (no testing-library in this project);
 * the logic under test is the conditions that drive disabled states and badge visibility.
 */

import { describe, it, expect } from "vitest";

// Mirror of isPublished() and formatPublishedAt() from page.tsx — tests the specification.
// Any drift between these helpers and the page implementation is a bug.
function isPublished(draft: { status: string }): boolean {
  return draft.status === "published";
}

function formatPublishedAt(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString("fr-CA", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shouldShowPublishedBadge(draft: { status: string; publishedAt: number | null }): boolean {
  return isPublished(draft) && draft.publishedAt !== null;
}

function deleteConfirmMessage(draft: { status: string }): string {
  return isPublished(draft)
    ? "Supprimer ce draft publié? L'historique de publication sera perdu (le post Facebook reste en ligne)."
    : "Supprimer ce draft?";
}

// Unix timestamp for 2 mai 2024 18:40 UTC
const MAY_2_2024_UTC = 1714675200; // 2024-05-02T18:40:00Z

describe("isPublished", () => {
  it("retourne true quand status=published", () => {
    expect(isPublished({ status: "published" })).toBe(true);
  });

  it("retourne false quand status=approved", () => {
    expect(isPublished({ status: "approved" })).toBe(false);
  });

  it("retourne false quand status=draft", () => {
    expect(isPublished({ status: "draft" })).toBe(false);
  });

  it("retourne false quand status=scheduled", () => {
    expect(isPublished({ status: "scheduled" })).toBe(false);
  });
});

describe("formatPublishedAt", () => {
  it("contient 'mai' pour une date en mai (format FR-CA)", () => {
    const result = formatPublishedAt(MAY_2_2024_UTC);
    expect(result).toMatch(/mai/i);
  });

  it("ne contient pas 'May' (format anglais)", () => {
    const result = formatPublishedAt(MAY_2_2024_UTC);
    expect(result).not.toMatch(/May/);
  });

  it("contient l'heure et la minute (format HH:MM)", () => {
    const result = formatPublishedAt(MAY_2_2024_UTC);
    // Should contain a time component (HH:MM format)
    expect(result).toMatch(/\d{2}\s*h\s*\d{2}|\d{1,2}:\d{2}/);
  });

  it("produit une chaîne non-vide pour un timestamp valide", () => {
    expect(formatPublishedAt(MAY_2_2024_UTC).length).toBeGreaterThan(0);
  });
});

describe("shouldShowPublishedBadge", () => {
  it("retourne true si status=published et publishedAt non-null", () => {
    expect(shouldShowPublishedBadge({ status: "published", publishedAt: MAY_2_2024_UTC })).toBe(true);
  });

  it("retourne false si publishedAt est null (même si published)", () => {
    expect(shouldShowPublishedBadge({ status: "published", publishedAt: null })).toBe(false);
  });

  it("retourne false si status=approved même avec publishedAt", () => {
    expect(shouldShowPublishedBadge({ status: "approved", publishedAt: MAY_2_2024_UTC })).toBe(false);
  });
});

describe("deleteConfirmMessage", () => {
  it("message spécifique pour draft publié (mentionne 'publié')", () => {
    const msg = deleteConfirmMessage({ status: "published" });
    expect(msg.toLowerCase()).toContain("publié");
    expect(msg).toContain("Facebook");
  });

  it("message court pour draft non-publié", () => {
    const msg = deleteConfirmMessage({ status: "draft" });
    expect(msg).toBe("Supprimer ce draft?");
  });

  it("message court pour draft approuvé", () => {
    const msg = deleteConfirmMessage({ status: "approved" });
    expect(msg).toBe("Supprimer ce draft?");
  });
});
