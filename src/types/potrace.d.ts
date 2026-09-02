/**
 * Minimal ambient types for `potrace`, which ships none and has no `@types/potrace`.
 *
 * Written to replace a file-wide `// @ts-nocheck` in scripts/vectorize-logos.ts: that
 * pragma silenced every error in the file, not just the untyped import, so a genuine
 * mistake anywhere else in it would have compiled clean.
 *
 * Only the surface that script actually uses is declared. Add to it if a caller needs more.
 */
declare module "potrace" {
  export interface TraceOptions {
    /** Fill colour of the traced silhouette, or "auto". */
    color?: string;
    /** Background colour, or "transparent". */
    background?: string;
    /** 0-255 luminance cutoff, or -1 for automatic. */
    threshold?: number;
    /** Suppress speckles smaller than this many pixels. */
    turdSize?: number;
    /** Curve-optimisation tolerance. */
    optTolerance?: number;
    /** Corner-detection threshold. */
    alphaMax?: number;
    turnPolicy?: string;
  }

  export function trace(
    input: Buffer | string,
    options: TraceOptions,
    callback: (err: Error | null, svg: string) => void,
  ): void;

  export function posterize(
    input: Buffer | string,
    options: TraceOptions & { steps?: number | number[] },
    callback: (err: Error | null, svg: string) => void,
  ): void;

  const potrace: {
    trace: typeof trace;
    posterize: typeof posterize;
  };
  export default potrace;
}
