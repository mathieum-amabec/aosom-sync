/**
 * "Bientôt" teasers — measure demand for a feature before paying to run it (Mat, 2026-10-20: "si les gens cliquent
 * dessus et sont intéressés, nous allons le faire").
 *
 * The storefront logs, once per visitor and entry point, the funnel: view (the button was on screen) → click → yes / no
 * ("ça vous aiderait ?") → email (asked to hear about the launch). Entry points ("source") are kept apart so their
 * rates never blend: "pdp" = the pill on the product photo, "sheet" = the décorateur line inside that sheet, "chat" =
 * the assistant's button. No PII in events: the visitor is a hash of a random id the browser keeps, and the theme
 * skips bots and visitors who refused analytics. A launch-notice email is stored only when the shopper types it,
 * together with the exact wording they agreed to, for that one notice.
 */
import crypto from "crypto";

export const TEASER_FEATURES = ["visualiser", "decorateur"] as const;
export type TeaserFeature = (typeof TEASER_FEATURES)[number];
export const TEASER_EVENTS = ["view", "click", "yes", "no", "email"] as const;
export type TeaserEvent = (typeof TEASER_EVENTS)[number];
export const TEASER_SOURCES = ["pdp", "sheet", "chat"] as const;
export type TeaserSource = (typeof TEASER_SOURCES)[number];

/**
 * The consent wording shown next to each email field, stored with the signup (CASL proof of what was agreed to).
 * Must stay identical to the theme copy (lc-visualiser, lc-assistant-widget); bump the version when it changes.
 */
export const CONSENT_TEXT = {
  fr: "v1 — Un seul courriel, au lancement. Pas d'infolettre. Vous pourrez vous désinscrire en tout temps.",
  en: "v1 — One email, at launch. No newsletter. You can unsubscribe at any time.",
} as const;

export function isTeaserFeature(v: unknown): v is TeaserFeature {
  return typeof v === "string" && (TEASER_FEATURES as readonly string[]).includes(v);
}
export function isTeaserEvent(v: unknown): v is TeaserEvent {
  return typeof v === "string" && (TEASER_EVENTS as readonly string[]).includes(v);
}
export function isTeaserSource(v: unknown): v is TeaserSource {
  return typeof v === "string" && (TEASER_SOURCES as readonly string[]).includes(v);
}

/** The browser's random visitor id: 16–64 url-safe characters. */
export function isVisitorId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(v);
}

export function hashVisitor(id: string): string {
  return crypto.createHash("sha256").update(`teaser:${id}`).digest("hex").slice(0, 32);
}

export interface FunnelRow {
  feature: TeaserFeature;
  source: TeaserSource;
  views: number;
  clicks: number;
  yes: number;
  no: number;
  emails: number;
  /** clicks / views, % (one decimal); null without views. For "sheet", a view = the visualiser sheet was opened. */
  clickRate: number | null;
  /** yes / (yes + no), % — among those who answered; null without answers. */
  yesRate: number | null;
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/** Unique-visitor funnel per (feature, source) that has any activity, from the raw (feature, source, event) counts. */
export function buildFunnel(
  rows: Array<{ feature: string; source: string; event: string; visitors: number }>,
  signups: Array<{ feature: string; source: string; n: number }>,
): FunnelRow[] {
  const out: FunnelRow[] = [];
  for (const feature of TEASER_FEATURES) {
    for (const source of TEASER_SOURCES) {
      const get = (event: TeaserEvent) => rows.find((r) => r.feature === feature && r.source === source && r.event === event)?.visitors ?? 0;
      const views = get("view"), clicks = get("click"), yes = get("yes"), no = get("no");
      const emails = signups.find((s) => s.feature === feature && s.source === source)?.n ?? 0;
      if (views + clicks + yes + no + emails === 0) continue;
      out.push({ feature, source, views, clicks, yes, no, emails, clickRate: pct(clicks, views), yesRate: pct(yes, yes + no) });
    }
  }
  return out;
}
