import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// JS replica of shopify-theme/snippets/lc-colour-css.liquid, driven by the snippet's own map and word list, so the
// white rule (Mat, 2026-10-20) can't silently regress: « blanc »/« white » ⇒ #FFFFFF, before crème/cream/ivoire.
const src = fs.readFileSync(path.join(__dirname, "../shopify-theme/snippets/lc-colour-css.liquid"), "utf8");
const MAP = src.match(/assign lc_map = '([^']+)'/)![1].split("|").map((e) => e.split("=") as [string, string]);
const OTHERS = src.match(/assign lc_others = '([^']+)'/)![1].split(",");

function colour(value: string): string {
  let v = value.toLowerCase().trim();
  const last = v.split(" ").at(-1)!;
  if (+last > 0) v = v.slice(0, v.length - last.length - 1);
  v = v.replace(/-/g, " ").replaceAll(" & ", ",").replaceAll(" et ", ",").replaceAll(" and ", ",").replaceAll(", ", ",").replaceAll("/", ",");
  const solids: string[] = [];
  let out = "";
  for (const part of v.split(",").slice(0, 3)) {
    const p = part.trim();
    if (!p) continue;
    const pp = ` ${p} `;
    let hit = "";
    if ((pp.includes(" blanc ") || pp.includes(" white ")) && !OTHERS.some((w) => pp.includes(` ${w} `))) hit = "#FFFFFF";
    if (!hit) for (const [k, x] of MAP) if (pp.includes(` ${k} `)) { hit = x; break; }
    if (!hit) return "";
    solids.push(hit.includes("gradient") ? "#" + hit.split("#")[1].slice(0, 6) : hit);
    if (solids.length === 1) out = hit;
  }
  if (solids.length === 2) out = `linear-gradient(135deg,${solids[0]} 50%,${solids[1]} 50%)`;
  return out;
}

describe("lc-colour-css white rule", () => {
  it("the snippet checks blanc/white before the map", () => {
    expect(src.indexOf("contains ' blanc '")).toBeGreaterThan(0);
    expect(src.indexOf("contains ' blanc '")).toBeLessThan(src.indexOf("for lc_e in lc_map"));
  });
  it("any value with the word blanc/white is pure white", () => {
    for (const v of ["Blanc crème", "Blanc cassé", "Cream white", "Blanc ivoire", "Blanc vieilli", "Cream White Wood Grain", "Off-white", "Blanc 2"]) {
      expect(colour(v), v).toBe("#FFFFFF");
    }
  });
  it("two-colour names keep the split dot", () => {
    expect(colour("Noir et blanc")).toBe("linear-gradient(135deg,#1a1a1a 50%,#FFFFFF 50%)");
    expect(colour("Gris et blanc")).toBe("linear-gradient(135deg,#808080 50%,#FFFFFF 50%)");
    expect(colour("Black White")).toBe("linear-gradient(135deg,#1a1a1a 50%,#FFFFFF 50%)");
    expect(colour("Orange/Green")).toBe("linear-gradient(135deg,#FFA500 50%,#228B22 50%)");
  });
  it("crème alone is unchanged, and whole words only", () => {
    expect(colour("Crème")).toBe("#FFFDD0");
    expect(colour("Blanchi")).not.toBe("#FFFFFF");
  });
});
