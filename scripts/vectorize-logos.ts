// @ts-nocheck
// scripts/vectorize-logos.ts
// webp → sharp (2x, white bg, b/w threshold) → potrace → SVG. Saves to Logo/*.svg.
// Standalone build-time tool (not part of the app/runtime); `potrace` ships no types.
import sharp from "sharp";
import potrace from "potrace";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LOGOS = [
  { src: "Logo/Ameublo/officiel.webp", out: "Logo/logo-fr.svg", brand: "Ameublo Direct (FR)" },
  { src: "Logo/Furnish/officiel.webp", out: "Logo/logo-en.svg", brand: "Furnish Direct (EN)" },
];

function trace(buf: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    potrace.trace(
      buf,
      { color: "#1A1A2E", background: "transparent", threshold: 128, turdSize: 2, optTolerance: 0.4 },
      (err: Error | null, svg: string) => (err ? reject(err) : resolve(svg)),
    );
  });
}

for (const lg of LOGOS) {
  const srcPath = path.join(ROOT, lg.src);
  if (!fs.existsSync(srcPath)) { console.log(`✗ ${lg.brand}: source manquante ${lg.src}`); continue; }
  const meta = await sharp(srcPath).metadata();
  const w = (meta.width ?? 600) * 2;
  // 2x PNG, fond blanc forcé, niveaux de gris, bitmap noir/blanc
  const png = await sharp(srcPath)
    .resize({ width: w })
    .flatten({ background: "#ffffff" })
    .greyscale()
    .normalise()
    .threshold(190)
    .png()
    .toBuffer();
  const svg = await trace(png);
  const outPath = path.join(ROOT, lg.out);
  fs.writeFileSync(outPath, svg, "utf8");
  console.log(`✓ ${lg.brand}: ${lg.src} (${meta.width}×${meta.height}) → ${lg.out}  (PNG ${Math.round(png.length / 1024)}KB → SVG ${(svg.length / 1024).toFixed(1)}KB)`);
}
console.log("Vectorisation terminée. (monochrome #1A1A2E — potrace trace une silhouette, pas les couleurs)");
