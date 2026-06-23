import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Make the bundled DM Sans TTFs resolvable by the SVG text renderer.
 *
 * Both social-image compositors (image-watermark.ts footer bar, image-compositor.ts
 * branded hero) draw text as SVG rendered by librsvg/Pango, which resolve fonts via
 * **fontconfig** — NOT Sharp's `fontfile` option (that only applies to `sharp({text})`).
 * Without a usable font on the render host the text renders as tofu boxes (the "carrés"
 * bug). So we write a fontconfig file pointing at src/fonts and set FONTCONFIG_FILE
 * before the first render, which makes `font-family: "DM Sans"` resolve to our TTFs.
 *
 * Call `registerBrandFonts()` at module load in every module that composes branded
 * images. It is idempotent (no-ops if FONTCONFIG_FILE is already set) and best-effort
 * (any failure falls back to the system font resolution), so it can never break a render.
 */

/** Directory where the bundled DM Sans TTFs live (traced into the function bundle). */
export function bundledFontsDir(): string {
  return path.join(process.cwd(), "src", "fonts");
}

/**
 * Build the fontconfig document that adds our bundled fonts dir to the search path.
 * Keeps the system fonts via an ignore-missing include (so an Arial/sans-serif
 * fallback still resolves where a system config exists).
 */
export function buildFontconfigXml(fontsDir: string, cacheDir: string): string {
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontsDir}</dir>
  <cachedir>${cacheDir}</cachedir>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
</fontconfig>`;
}

/**
 * Register the bundled DM Sans TTFs via fontconfig. Scoped to Linux (the Vercel
 * runtime that renders these posts): on dev machines we leave the platform font
 * resolution untouched to avoid perturbing the local Sharp build. Best-effort.
 */
export function registerBrandFonts(): void {
  if (process.platform !== "linux") return;
  if (process.env.FONTCONFIG_FILE) return; // already configured by us or the platform
  try {
    const fontsDir = bundledFontsDir();
    if (!fs.existsSync(path.join(fontsDir, "DMSans-Bold.ttf"))) return; // not bundled in this function
    const cacheDir = path.join(os.tmpdir(), "fontconfig-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const confPath = path.join(os.tmpdir(), "aosom-fonts.conf");
    fs.writeFileSync(confPath, buildFontconfigXml(fontsDir, cacheDir));
    process.env.FONTCONFIG_FILE = confPath;
  } catch {
    // non-fatal — fall back to system font resolution
  }
}
