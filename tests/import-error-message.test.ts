import { describe, it, expect } from "vitest";
import { describeImportFailure, describeSkippedImports } from "@/lib/import-error-message";

/**
 * catalog/page.tsx used to do `if (res.ok) { ... }` with NO else, so every
 * non-2xx — 504 timeout, 400 over the cap, 401 expired session — produced
 * nothing at all on screen. These tests pin the message the operator now gets
 * for each failure, and that the helper never throws on a non-JSON body.
 */

/** Minimal Response stand-in: only status + json() are used. */
function res(status: number, body?: unknown) {
  return {
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError("Unexpected token < in JSON");
      return body;
    },
  };
}

describe("describeImportFailure", () => {
  it("explains a 504 as a partial import, not as nothing happened", async () => {
    // Vercel answers a timeout with HTML, so json() rejects — the helper must cope.
    const msg = await describeImportFailure(res(504), 40);
    expect(msg).toContain("trop de temps");
    expect(msg).toContain("40");
    // The honest part: jobs written before the kill are committed.
    expect(msg).toMatch(/partie a pu être ajoutée/i);
    expect(msg).toMatch(/moins de produits/i);
  });

  it("treats a 408 like a timeout", async () => {
    expect(await describeImportFailure(res(408), 12)).toContain("trop de temps");
  });

  it("names the cap and the exact number to deselect", async () => {
    const msg = await describeImportFailure(
      res(400, { code: "batch_too_large", max: 40, received: 57 }),
      57,
    );
    expect(msg).toContain("Maximum 40 produits");
    expect(msg).toContain("57");
    expect(msg).toContain("Désélectionnez-en 17");
  });

  it("never asks for a negative number of deselections", async () => {
    const msg = await describeImportFailure(
      res(400, { code: "batch_too_large", max: 40, received: 3 }),
      3,
    );
    expect(msg).toContain("Désélectionnez-en 0");
  });

  it("tells the operator to log back in on 401", async () => {
    expect(await describeImportFailure(res(401, { error: "Unauthorized" }), 5)).toMatch(
      /session expirée/i,
    );
  });

  it("says nothing was added on a 500", async () => {
    const msg = await describeImportFailure(res(500, { error: "Queue operation failed" }), 5);
    expect(msg).toContain("500");
    expect(msg).toMatch(/aucun produit n'a été ajouté/i);
  });

  it("surfaces the route's own validation wording on other 4xx", async () => {
    const msg = await describeImportFailure(res(400, { error: "No valid SKUs provided" }), 2);
    expect(msg).toContain("No valid SKUs provided");
  });

  it("still produces a message when the body is not JSON at all", async () => {
    const msg = await describeImportFailure(res(418), 1);
    expect(msg).toContain("418");
    expect(msg.length).toBeGreaterThan(10);
  });

  it("never returns an empty string for any plausible status", async () => {
    for (const status of [400, 401, 403, 404, 408, 429, 500, 502, 503, 504]) {
      const msg = await describeImportFailure(res(status), 10);
      expect(msg.trim(), `status ${status} produced no message`).not.toBe("");
    }
  });
});

describe("describeSkippedImports", () => {
  // queueForImport's `skipped` list used to have no wording at all — a batch
  // that skipped everything looked identical to a full success.
  it("names a single vanished-from-feed SKU with the requested wording (840-158GN)", () => {
    const msg = describeSkippedImports([{ sku: "840-158GN", reason: "not_in_feed" }]);
    expect(msg).toContain("n'est plus disponible chez le fournisseur");
    expect(msg).toContain("retiré de votre sélection");
    expect(msg).toContain("840-158GN");
  });

  it("pluralizes multiple vanished-from-feed SKUs", () => {
    const msg = describeSkippedImports([
      { sku: "840-158GN", reason: "not_in_feed" },
      { sku: "840-159GN", reason: "not_in_feed" },
    ]);
    expect(msg).toContain("2 produits");
    expect(msg).toContain("840-158GN, 840-159GN");
  });

  it("names a single already-imported SKU (501-004PK)", () => {
    const msg = describeSkippedImports([{ sku: "501-004PK", reason: "already_imported" }]);
    expect(msg).toMatch(/déjà importé/i);
    expect(msg).toContain("501-004PK");
  });

  it("reports both reasons as separate sentences when a batch mixes them", () => {
    const msg = describeSkippedImports([
      { sku: "840-158GN", reason: "not_in_feed" },
      { sku: "501-004PK", reason: "already_imported" },
    ]);
    expect(msg).toContain("840-158GN");
    expect(msg).toContain("501-004PK");
    expect(msg).toMatch(/n'est plus disponible[\s\S]*déjà importé|déjà importé[\s\S]*n'est plus disponible/);
  });

  it("never returns an empty string, even for an unrecognized reason", () => {
    const msg = describeSkippedImports([{ sku: "X", reason: "some_future_reason" }]);
    expect(msg.trim()).not.toBe("");
  });
});
