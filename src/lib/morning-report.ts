/**
 * Morning report — Mat's daily 06:00 (America/Montreal) email digest.
 *
 * STRICTLY READ-ONLY: every source below only reads (Turso, Meta insights). Nothing here
 * approves, publishes, schedules or mutates anything — it's a summary so Mat doesn't have to
 * go fetch the numbers himself.
 *
 * Each section is collected independently: a source that throws (Meta API down, a missing
 * table…) becomes a `{ ok: false }` section rendered as "section indisponible", and the email
 * still goes out with everything else. Pure collect/render so both are unit-tested without
 * a DB or network (sources are injected).
 */
import type { CampaignDaySummary } from "./meta-ads-client";

export const REPORT_TIME_ZONE = "America/Montreal";
/** Local hour the report must go out at. The cron fires at 10:00 and 11:00 UTC (06:00 EDT /
 *  06:00 EST); the route sends only on the run where this is the Montreal wall-clock hour. */
export const REPORT_LOCAL_HOUR = 6;

// ── sections ──────────────────────────────────────────────────────────────────
export type Section<T> = { ok: true; data: T } | { ok: false; error: string };

export interface GuidesSummary {
  pending: number;
  ready: number;
  attention: number;
  /** Titles of the "attention" guides (capped), so Mat knows which ones need a look. */
  attentionTitles: string[];
}

export interface VideosSummary {
  /** Videos waiting for approval on /content-formats. */
  pendingApproval: number;
  /** Approved videos queued to publish in the next `horizonDays` days. */
  scheduledSoon: number;
  horizonDays: number;
}

export interface AlertItem {
  label: string;
  count: number;
}

export interface BlockedItem {
  label: string;
  count: number;
}

export interface MorningReportData {
  /** Montreal calendar date the report is for (YYYY-MM-DD). */
  reportDate: string;
  /** The day the Meta figures cover (the ad account's "yesterday"). */
  metaDay: string;
  meta: Section<CampaignDaySummary[]>;
  guides: Section<GuidesSummary>;
  videos: Section<VideosSummary>;
  alerts: Section<AlertItem[]>;
  blocked: Section<BlockedItem[]>;
}

export interface MorningReportSources {
  meta: (day: string) => Promise<CampaignDaySummary[]>;
  guides: () => Promise<GuidesSummary>;
  videos: () => Promise<VideosSummary>;
  alerts: () => Promise<AlertItem[]>;
  blocked: () => Promise<BlockedItem[]>;
}

// ── time helpers ──────────────────────────────────────────────────────────────
/** Wall-clock date + hour of `now` in `timeZone`. */
export function localClock(now: Date, timeZone = REPORT_TIME_ZONE): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** YYYY-MM-DD of the calendar day before `date` (YYYY-MM-DD). */
export function previousDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── collect ───────────────────────────────────────────────────────────────────
async function settle<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function collectMorningReport(sources: MorningReportSources, now: Date): Promise<MorningReportData> {
  const reportDate = localClock(now).date;
  const metaDay = previousDay(reportDate);
  const [meta, guides, videos, alerts, blocked] = await Promise.all([
    settle(() => sources.meta(metaDay)),
    settle(sources.guides),
    settle(sources.videos),
    settle(sources.alerts),
    settle(sources.blocked),
  ]);
  return { reportDate, metaDay, meta, guides, videos, alerts, blocked };
}

// ── render ────────────────────────────────────────────────────────────────────
const money = (n: number) =>
  new Intl.NumberFormat("fr-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 2 }).format(n);
const int = (n: number) => new Intl.NumberFormat("fr-CA").format(Math.round(n));
// French: 0 and 1 take the singular.
const plural = (n: number, one: string, many: string) => `${int(n)} ${n >= 2 ? many : one}`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const LEARNING_LABEL: Record<string, string> = {
  LEARNING: "en apprentissage",
  SUCCESS: "apprentissage terminé",
  FAIL: "apprentissage limité",
  WAIVING: "apprentissage non requis",
};

function learningLabel(statuses: string[]): string {
  if (statuses.length === 0) return "apprentissage : pas encore de statut";
  return statuses.map((s) => LEARNING_LABEL[s] ?? s.toLowerCase()).join(" / ");
}

/** Friendly day label, e.g. "mercredi 24 septembre". */
function dayLabel(date: string): string {
  return new Intl.DateTimeFormat("fr-CA", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

/** Lines (plain text) for each section; the HTML is built from the same lines. */
function sectionLines(data: MorningReportData): Array<{ title: string; lines: string[]; missing?: string }> {
  const out: Array<{ title: string; lines: string[]; missing?: string }> = [];

  // 1. Meta
  {
    const title = `Publicités Meta — ${dayLabel(data.metaDay)}`;
    if (!data.meta.ok) out.push({ title, lines: [], missing: data.meta.error });
    else if (data.meta.data.length === 0) out.push({ title, lines: ["Aucune campagne active."] });
    else {
      const rows = data.meta.data;
      const total = rows.reduce((s, r) => s + r.spend, 0);
      const lines = rows.map((r) => {
        const sales =
          r.purchases > 0
            ? `${plural(r.purchases, "achat", "achats")} (${money(r.purchaseValue)})`
            : "0 achat";
        const budget = r.dailyBudget != null ? ` / ${money(r.dailyBudget / 100)} par jour` : "";
        return (
          `${r.name} : ${money(r.spend)}${budget} · ${plural(r.impressions, "impression", "impressions")} · ` +
          `${plural(r.linkClicks, "clic", "clics")} · ${sales} · ${learningLabel(r.learning)}`
        );
      });
      lines.push(`Total dépensé : ${money(total)}`);
      out.push({ title, lines });
    }
  }

  // 2. Guides
  {
    const title = "Guides en attente d'approbation";
    if (!data.guides.ok) out.push({ title, lines: [], missing: data.guides.error });
    else {
      const g = data.guides.data;
      const lines =
        g.pending === 0
          ? ["Aucun guide en attente."]
          : [`${plural(g.pending, "guide", "guides")} en attente : ${int(g.ready)} prêts, ${int(g.attention)} à vérifier.`];
      if (g.attentionTitles.length) lines.push(`À vérifier : ${g.attentionTitles.join(" · ")}`);
      out.push({ title, lines });
    }
  }

  // 3. Videos
  {
    const title = "Vidéos";
    if (!data.videos.ok) out.push({ title, lines: [], missing: data.videos.error });
    else {
      const v = data.videos.data;
      out.push({
        title,
        lines: [
          `${plural(v.pendingApproval, "vidéo", "vidéos")} en attente d'approbation.`,
          `${plural(v.scheduledSoon, "vidéo planifiée", "vidéos planifiées")} dans les ${v.horizonDays} prochains jours.`,
        ],
      });
    }
  }

  // 4. Alerts
  {
    const title = "Alertes";
    if (!data.alerts.ok) out.push({ title, lines: [], missing: data.alerts.error });
    else {
      const active = data.alerts.data.filter((a) => a.count > 0);
      out.push({ title, lines: active.length ? active.map((a) => `${a.label} : ${int(a.count)}`) : ["Rien à signaler."] });
    }
  }

  // 5. Blocked on Mat
  {
    const title = "En attente de ton action";
    if (!data.blocked.ok) out.push({ title, lines: [], missing: data.blocked.error });
    else {
      const active = data.blocked.data.filter((b) => b.count > 0);
      out.push({ title, lines: active.length ? active.map((b) => `${b.label} : ${int(b.count)}`) : ["Rien en attente."] });
    }
  }
  return out;
}

export interface RenderedReport {
  subject: string;
  html: string;
  text: string;
  /** Titles of sections that could not be collected (empty when complete). */
  missingSections: string[];
}

export function renderMorningReport(data: MorningReportData): RenderedReport {
  const sections = sectionLines(data);
  const missingSections = sections.filter((s) => s.missing !== undefined).map((s) => s.title);
  const heading = `Rapport du matin — ${dayLabel(data.reportDate)}`;
  const subject = missingSections.length
    ? `${heading} (${plural(missingSections.length, "section indisponible", "sections indisponibles")})`
    : heading;

  const text = [
    heading,
    "",
    ...sections.flatMap((s) => [
      s.title.toUpperCase(),
      ...(s.missing !== undefined ? [`⚠ Section indisponible (${s.missing})`] : s.lines.map((l) => `• ${l}`)),
      "",
    ]),
    "Rapport informatif uniquement — aucune action n'a été déclenchée.",
  ].join("\n");

  const block = (s: (typeof sections)[number]) => {
    const body =
      s.missing !== undefined
        ? `<p style="margin:0;color:#b45309">⚠ Section indisponible — ${escapeHtml(s.missing)}</p>`
        : `<ul style="margin:0;padding-left:18px">${s.lines
            .map((l) => `<li style="margin:2px 0">${escapeHtml(l)}</li>`)
            .join("")}</ul>`;
    return (
      `<h2 style="font-size:15px;margin:18px 0 6px;color:#111">${escapeHtml(s.title)}</h2>` + body
    );
  };
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.45;color:#222;max-width:600px">` +
    `<h1 style="font-size:18px;margin:0 0 4px">${escapeHtml(heading)}</h1>` +
    sections.map(block).join("") +
    `<p style="margin:20px 0 0;font-size:12px;color:#777">Rapport informatif uniquement — aucune action n'a été déclenchée.</p>` +
    `</div>`;

  return { subject, html, text, missingSections };
}
