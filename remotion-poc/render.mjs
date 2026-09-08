/**
 * Render the three POC clips and time each one.
 *
 * Programmatic rather than `remotion render` on the CLI so the bundle is built ONCE and only
 * the per-clip render is timed. Timing the CLI three times would charge each clip for a full
 * webpack bundle and make the comparison against ffmpeg meaningless.
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";

const here = path.dirname(fileURLToPath(import.meta.url));
const inputs = JSON.parse(fs.readFileSync(path.join(here, "v3-inputs.json"), "utf8"));
const OUT = process.env.POC_OUT || "C:\\Users\\vente\\Downloads\\test-videos-remotion-poc";
fs.mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
console.log("bundling…");
const serveUrl = await bundle({
  entryPoint: path.join(here, "src", "index.ts"),
  publicDir: path.join(here, "public"),
  onProgress: () => {},
});
const bundleMs = Date.now() - t0;
console.log(`bundle: ${(bundleMs / 1000).toFixed(1)}s\n`);

const results = [];
for (const c of inputs.clips) {
  const id = c.sku.replace(/[^A-Za-z0-9-]/g, "");
  const outPath = path.join(OUT, `${c.sku}.mp4`);
  const start = Date.now();
  const composition = await selectComposition({ serveUrl, id });
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    crf: 20,
    pixelFormat: "yuv420p",
    outputLocation: outPath,
    concurrency: Number(process.env.POC_CONCURRENCY || 4),
    onProgress: () => {},
  });
  const ms = Date.now() - start;
  const size = fs.statSync(outPath).size;
  results.push({ sku: c.sku, ms, size, outPath });
  console.log(
    `  ${c.sku.padEnd(12)} ${(ms / 1000).toFixed(1).padStart(6)}s  ${(size / 1024).toFixed(0).padStart(6)} Ko  -> ${outPath}`,
  );
}

console.log(`\nbundle ${(bundleMs / 1000).toFixed(1)}s + rendus ${(results.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(1)}s`);
fs.writeFileSync(path.join(here, "poc-results.json"), JSON.stringify({ bundleMs, results }, null, 2));
