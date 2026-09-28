/**
 * Studio Avant/Après — the menu of choices Mat picks from, and validation of a render request.
 * Pure module (no I/O) so the UI, the API and the renderer share one source of truth.
 */

export type StudioFormat = "9:16" | "4:5";
export const FORMATS: Record<StudioFormat, { w: number; h: number; label: string }> = {
  "9:16": { w: 1080, h: 1920, label: "Vertical 9:16 (Reels, Stories)" },
  "4:5": { w: 1080, h: 1350, label: "Portrait 4:5 (fil d'actualité, pubs)" },
};

export const DURATIONS = [6, 10, 15] as const;
export type StudioDuration = (typeof DURATIONS)[number];

export type ImageFit = "contain" | "cover";

/**
 * Transitions offered to Mat. `xfade` is the ffmpeg xfade transition name; `slider` is our
 * own "curseur comparatif": a left-to-right wipe with a visible divider line riding the edge.
 */
export interface TransitionDef {
  id: string;
  label: string;
  description: string;
  kind: "slider" | "xfade";
  xfade: string;
  /** Transition length in seconds. */
  duration: number;
}

export const TRANSITIONS: TransitionDef[] = [
  { id: "slider", label: "Curseur comparatif", description: "Une ligne balaie l'image et révèle l'après — le classique avant/après.", kind: "slider", xfade: "wiperight", duration: 1.8 },
  { id: "dissolve", label: "Fondu", description: "L'avant se fond doucement dans l'après.", kind: "xfade", xfade: "dissolve", duration: 0.9 },
  { id: "wipe", label: "Balayage", description: "L'après pousse l'avant vers la gauche, sans ligne.", kind: "xfade", xfade: "wipeleft", duration: 0.8 },
  { id: "slide", label: "Glissement", description: "L'après glisse par-dessus l'avant.", kind: "xfade", xfade: "slideleft", duration: 0.7 },
  { id: "curtain", label: "Rideau", description: "L'après s'ouvre du centre vers les côtés.", kind: "xfade", xfade: "vertopen", duration: 0.9 },
  { id: "circle", label: "Cercle", description: "L'après apparaît dans un cercle qui grandit.", kind: "xfade", xfade: "circleopen", duration: 1.0 },
  { id: "zoom", label: "Zoom", description: "Zoom rapide vers l'après.", kind: "xfade", xfade: "zoomin", duration: 0.8 },
  { id: "pixelize", label: "Pixelisation", description: "L'avant se pixelise puis devient l'après.", kind: "xfade", xfade: "pixelize", duration: 1.0 },
];

export function getTransition(id: string): TransitionDef | undefined {
  return TRANSITIONS.find((t) => t.id === id);
}

export type StudioLocale = "fr" | "en";

export interface StudioImageChoice {
  url: string;
  fit: ImageFit;
}

export interface StudioRenderRequest {
  sku: string;
  shopifyProductId: string;
  productTitle: string;
  before: StudioImageChoice;
  after: StudioImageChoice;
  transition: string;
  durationSec: StudioDuration;
  format: StudioFormat;
  locale: StudioLocale;
  /** Blob URL of the track, or null for no music. */
  musicUrl: string | null;
  musicStartSec: number;
  texts: {
    labels: boolean;
    /** Headline at the top; empty = none. */
    title: string;
    /** e.g. "129,99 $"; empty = none. */
    price: string;
    /** Gold pill above the brand bar; empty = none. */
    cta: string;
  };
}

/** Hosts a render may download from: Shopify CDN (product photos) and our own public Blob store. */
const ALLOWED_IMAGE_HOSTS = [/^cdn\.shopify\.com$/, /\.public\.blob\.vercel-storage\.com$/];

export function isAllowedMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && ALLOWED_IMAGE_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Validate and normalise an untrusted render request body. Returns an error message or the request. */
export function parseRenderRequest(body: unknown): { ok: true; value: StudioRenderRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Corps de requête invalide" };
  const b = body as Record<string, unknown>;
  const img = (v: unknown, name: string): StudioImageChoice | string => {
    const o = (v ?? {}) as Record<string, unknown>;
    if (typeof o.url !== "string" || !isAllowedMediaUrl(o.url)) return `Image ${name} manquante ou non autorisée`;
    const fit: ImageFit = o.fit === "cover" ? "cover" : "contain";
    return { url: o.url, fit };
  };
  const sku = clip(b.sku, 40);
  const shopifyProductId = clip(b.shopifyProductId, 40);
  if (!sku || !shopifyProductId) return { ok: false, error: "Produit manquant" };
  const before = img(b.before, "Avant");
  if (typeof before === "string") return { ok: false, error: before };
  const after = img(b.after, "Après");
  if (typeof after === "string") return { ok: false, error: after };
  if (before.url === after.url) return { ok: false, error: "Choisis deux images différentes pour l'avant et l'après" };
  const transition = typeof b.transition === "string" && getTransition(b.transition) ? b.transition : null;
  if (!transition) return { ok: false, error: "Transition inconnue" };
  const durationSec = DURATIONS.find((d) => d === Number(b.durationSec));
  if (!durationSec) return { ok: false, error: "Durée invalide (6, 10 ou 15 s)" };
  const format = b.format === "4:5" || b.format === "9:16" ? b.format : null;
  if (!format) return { ok: false, error: "Format invalide" };
  const locale: StudioLocale = b.locale === "en" ? "en" : "fr";
  let musicUrl: string | null = null;
  if (b.musicUrl !== null && b.musicUrl !== undefined && b.musicUrl !== "") {
    if (typeof b.musicUrl !== "string" || !isAllowedMediaUrl(b.musicUrl)) return { ok: false, error: "Musique non autorisée" };
    musicUrl = b.musicUrl;
  }
  const musicStartSec = Math.max(0, Math.min(180, Math.floor(Number(b.musicStartSec) || 0)));
  const t = (b.texts ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    value: {
      sku,
      shopifyProductId,
      productTitle: clip(b.productTitle, 200) || sku,
      before,
      after,
      transition,
      durationSec,
      format,
      locale,
      musicUrl,
      musicStartSec,
      texts: { labels: t.labels !== false, title: clip(t.title, 80), price: clip(t.price, 24), cta: clip(t.cta, 48) },
    },
  };
}

/** Timeline of a render: when the transition starts and how long each still is on screen. */
export function studioTimeline(durationSec: number, transitionSec: number) {
  const hold = (durationSec - transitionSec) / 2;
  return {
    transitionStart: hold,
    transitionEnd: hold + transitionSec,
    /** Seconds of the BEFORE still input (hold + transition overlap). */
    beforeSec: hold + transitionSec,
    /** Seconds of the AFTER still input. */
    afterSec: durationSec - hold,
  };
}
