/**
 * Remix engine (Module F) — public surface.
 *
 * Compiles the existing demand-gen video library (`video_demand_gen`) into new
 * thematic compilations. `renderRemix` is the entry point; the `build*`
 * shortcuts pin a theme so callers only pass ratio/brand/language/dryRun.
 */
export type {
  RemixConfig,
  RemixClip,
  RemixManifest,
  RemixResult,
  RemixTheme,
  RemixDurationFilter,
} from "./types";

export { selectRemixClips, THEME_PRODUCT_TYPES, DEFAULT_MAX_CLIPS } from "./selector";
export {
  renderRemix,
  buildRemixManifest,
  buildRemixFilterComplex,
  introTitle,
  remixBlobPath,
  estimateRemixDuration,
} from "./render";

import { renderRemix } from "./render";
import type { RemixConfig, RemixResult } from "./types";

/** A remix request with the theme already fixed by a shortcut. */
export type RemixShortcutOpts = Omit<RemixConfig, "theme">;

/** Summer / backyard edit (Patio/Garden/Outdoor/Pool). */
export function buildEteCour(opts: RemixShortcutOpts): Promise<RemixResult> {
  return renderRemix({ ...opts, theme: "ete-cour" });
}

/** Home / interior edit (Indoor Furniture/Storage/Lighting). */
export function buildMaison(opts: RemixShortcutOpts): Promise<RemixResult> {
  return renderRemix({ ...opts, theme: "maison" });
}

/** Kids edit (Kids/Toys/Baby). */
export function buildEnfants(opts: RemixShortcutOpts): Promise<RemixResult> {
  return renderRemix({ ...opts, theme: "enfants" });
}

/** Sale edit — random across the whole library. */
export function buildSoldes(opts: RemixShortcutOpts): Promise<RemixResult> {
  return renderRemix({ ...opts, theme: "soldes" });
}
