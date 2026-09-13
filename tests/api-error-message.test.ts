import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  describeApiFailure,
  describePayloadFailure,
  describeNetworkFailure,
} from "@/lib/api-error-message";

/**
 * The shared failure wording behind the six dashboard fixes, plus structural
 * pins on the call sites. The repo has no React testing stack, so the wiring —
 * which cannot be observed without mounting — is asserted against the source,
 * the same compromise documented in tests/catalog-import-ui.test.ts.
 */

function res(status: number, body?: unknown) {
  return {
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError("Unexpected token < in JSON");
      return body;
    },
  };
}

const DASH = path.join(__dirname, "..", "src", "app", "(dashboard)");
const read = (...p: string[]) => fs.readFileSync(path.join(DASH, ...p), "utf8");

/**
 * Drop line, block and JSX comments before asserting on code. The comments
 * explaining these very fixes mention `alert()` in prose, and would otherwise
 * fail the "no alert() left" checks.
 */
const codeOnly = (src: string) =>
  src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("describeApiFailure", () => {
  it("tells the operator to reconnect on 401", async () => {
    expect(await describeApiFailure(res(401), "L'enregistrement")).toMatch(/session expirée/i);
  });

  it("names the action in a 5xx message", async () => {
    const msg = await describeApiFailure(res(500, { error: "boom" }), "L'enregistrement");
    expect(msg).toContain("L'enregistrement");
    expect(msg).toContain("500");
    expect(msg).toContain("boom");
  });

  it("treats 504 as interrupted, not as nothing-happened", async () => {
    const msg = await describeApiFailure(res(504), "La synchronisation");
    expect(msg).toMatch(/trop de temps/i);
    expect(msg).toMatch(/ce qui a été appliqué/i);
  });

  it("survives a non-JSON body (a platform 502 answers with HTML)", async () => {
    const msg = await describeApiFailure(res(502), "L'action");
    expect(msg).toMatch(/indisponible/i);
  });

  it("distinguishes 403 from 401", async () => {
    expect(await describeApiFailure(res(403), "L'action")).toMatch(/non autorisée/i);
  });

  it("never returns an empty string for any plausible status", async () => {
    for (const s of [400, 401, 403, 404, 408, 429, 500, 502, 503, 504]) {
      expect((await describeApiFailure(res(s), "L'action")).trim(), `status ${s}`).not.toBe("");
    }
  });
});

describe("describePayloadFailure", () => {
  it("surfaces the server's own wording when there is one", () => {
    expect(describePayloadFailure("quota dépassé", "La génération")).toBe(
      "La génération a échoué : quota dépassé",
    );
  });

  it("still says something when the server sent no reason", () => {
    expect(describePayloadFailure(undefined, "La génération")).toBe("La génération a échoué.");
    expect(describePayloadFailure("   ", "La génération")).toBe("La génération a échoué.");
  });
});

describe("describeNetworkFailure", () => {
  it("makes clear nothing was sent", () => {
    expect(describeNetworkFailure("L'enregistrement")).toMatch(/n'a pas été envoyée/i);
  });
});

describe("call sites are wired (structural)", () => {
  it("settings save handles non-ok, payload failure and network separately", () => {
    const src = read("settings", "page.tsx");
    expect(src).toContain('describeApiFailure(res, "L\'enregistrement")');
    expect(src).toContain('describePayloadFailure(data.error, "L\'enregistrement")');
    expect(src).toContain('describeNetworkFailure("L\'enregistrement")');
    // The save used to have no try/catch at all, so a throw left `saving` stuck true.
    expect(src).toMatch(/async function saveChanges\(\)[\s\S]{0,900}?try \{/);
  });

  it("settings save keeps the dirty set on failure", () => {
    const src = read("settings", "page.tsx");
    const fn = src.slice(src.indexOf("async function saveChanges"));
    const body = fn.slice(0, fn.indexOf("\n  }"));
    // setDirty(new Set()) must appear only in the success branch.
    expect((body.match(/setDirty\(new Set\(\)\)/g) || []).length).toBe(1);
    expect(body).toMatch(/data\.success[\s\S]{0,120}setDirty\(new Set\(\)\)/);
  });

  it("social no longer uses system alert()", () => {
    const src = codeOnly(read("social", "page.tsx"));
    expect(src).not.toMatch(/\balert\(/);
    expect(src).toContain("<ErrorBanner");
  });

  it("collections surfaces both save and sync failures", () => {
    const src = codeOnly(read("collections", "page.tsx"));
    expect(src).not.toMatch(/\balert\(/);
    expect(src).toContain("L'enregistrement des mappings");
    expect(src).toContain("La synchronisation des collections");
    expect(src).toContain("<ErrorBanner");
  });

  it("video status change no longer discards its response", () => {
    const src = read("videos", "videos-client.tsx");
    const fn = src.slice(src.indexOf("async function setStatus"));
    const body = fn.slice(0, fn.indexOf("\n  }"));
    expect(body).toContain("if (!res.ok)");
    expect(body).toContain("describeApiFailure");
    // onChange() must not run when the PATCH was rejected.
    expect(body).toMatch(/setStatusError[\s\S]*return;/);
  });
});
