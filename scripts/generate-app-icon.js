#!/usr/bin/env node
// Generates the Meta App Review app icon (1024x1024 + 512x512) from an inline
// SVG. Sharp rasterizes the SVG to PNG so no node-canvas dependency is needed.
// Run: node scripts/generate-app-icon.js

const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

const OUT_DIR = path.resolve(__dirname, "..", "public");
const BG = "#1e40af";
const FG = "#ffffff";
const MONOGRAM = "AS";

function buildSvg(size) {
  const radius = Math.round(size * 0.18);
  const fontSize = Math.round(size * 0.52);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2563eb"/>
      <stop offset="100%" stop-color="${BG}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="url(#bg)"/>
  <text x="50%" y="50%"
        font-family="Helvetica, Arial, sans-serif"
        font-size="${fontSize}"
        font-weight="800"
        fill="${FG}"
        text-anchor="middle"
        dominant-baseline="central"
        letter-spacing="-6">${MONOGRAM}</text>
</svg>`;
}

async function render(size) {
  const svg = buildSvg(size);
  const outPath = path.join(OUT_DIR, `meta-app-icon-${size}.png`);
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(outPath);
  const { size: bytes } = fs.statSync(outPath);
  console.log(`✓ ${outPath} (${(bytes / 1024).toFixed(1)} KB)`);
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  await render(1024);
  await render(512);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
