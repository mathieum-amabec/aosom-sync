import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Regression guards for the supplier-name leak found on 2026-08-19.
 *
 * Eight generated articles carried forbidden names, six of them published:
 *   - all 8 had `utm_source=aosom-sync` four times each, from buildAttributionUrl
 *   - two had the prose "Chez Aosom Canada, vous trouverez…", because the system prompt
 *     literally introduced the writer as working "for Aosom Canada"
 *
 * Both causes are code, not model error, so both are pinned here.
 */

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

const FORBIDDEN = ["Aosom", "HOMCOM", "Outsunny", "PawHut", "Vinsetto", "Qaba", "Soozier"];

describe("blog system prompt", () => {
  const src = read("src/lib/blog-generator.ts");
  const prompt = src.slice(src.indexOf("SYSTEM_PROMPT_BASE"), src.indexOf("function langPromptFragment"));

  it("introduces the writer as the STORE, never as the supplier", () => {
    expect(prompt).toContain("Ameublo Direct");
    expect(prompt).toContain("Furnish Direct");
    expect(prompt).not.toMatch(/writer for Aosom/i);
  });

  it("names every forbidden supplier explicitly so the model can avoid them", () => {
    for (const name of FORBIDDEN) {
      expect(prompt, `prompt must name ${name}`).toContain(name);
    }
  });

  it("forbids internal tool names in URLs, UTMs, tags and metadata", () => {
    expect(prompt).toMatch(/aosom-sync/);
    expect(prompt).toMatch(/UTM/i);
  });
});

describe("unsplash attribution utm_source", () => {
  it("does not default to the internal repo name — it ships in published article HTML", () => {
    const cfg = read("src/lib/config.ts");
    // Target the CODE line, not the comment above it: the comment names "aosom-sync"
    // precisely because it documents the leak, and a looser match reads it as the default.
    const line = cfg.split("\n").find((l) => l.includes("process.env.UNSPLASH_APP_NAME"));
    expect(line, "no UNSPLASH_APP_NAME fallback found").toBeDefined();
    expect(line).not.toMatch(/aosom-sync/);
    expect(line).toMatch(/ameublodirect/);
  });
});

describe("CSP media-src", () => {
  const cfg = read("next.config.ts");

  /**
   * Match the directive inside its string literal. A bare /media-src/ also hits the comment
   * that explains why the directive exists, which would let the test pass with no directive
   * at all — the first version of this test did exactly that.
   */
  const directive = cfg.match(/"media-src [^"]*"/)?.[0] ?? "";

  it("declares media-src, without which every dashboard video preview is blocked", () => {
    expect(directive, "no media-src string literal in the CSP").not.toBe("");
  });

  it("allows blob: and the public Vercel Blob store the renders are served from", () => {
    expect(directive).toContain("'self'");
    expect(directive).toContain("blob:");
    expect(directive).toContain("jcskqp8orcub9i0l.public.blob.vercel-storage.com");
  });

  it("keeps frame-ancestors 'none' — the media rule must not loosen clickjacking cover", () => {
    expect(cfg).toContain("frame-ancestors 'none'");
  });
});

describe("Next.js version", () => {
  it("is at least 16.3.1 (proxy bypass GHSA-6gpp-xcg3-4w24)", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    const raw = pkg.dependencies.next.replace(/^[\^~]/, "");
    const [maj, min, patch] = raw.split(".").map(Number);
    const atLeast = maj > 16 || (maj === 16 && (min > 3 || (min === 3 && patch >= 1)));
    expect(atLeast, `next is ${raw}`).toBe(true);
  });
});
