/**
 * One red/green verdict per daily guard, from what each guard already persisted.
 *
 * The guards themselves (price-audit, catalog-consistency, image-compliance inside the sync,
 * feed-integrity) run on their own crons and store a result; this module only READS those
 * results and decides what needs Mat's attention. It feeds two places so they can never
 * disagree: the dashboard "Alertes" panel and the 06:00 morning report email.
 *
 * A guard is red when it found something (see each rule below), when its last run failed, or
 * when it has gone quiet — a guard that silently stopped running protects nothing, so a result
 * older than STALE_AFTER_SECS is itself an alert.
 */
import { loadGuardInputs, type GuardInputs } from "./database";

export type GuardKey = "price" | "catalog" | "images" | "feed";
/** "unknown" = never produced a result yet (e.g. a guard deployed today). Not an alert. */
export type GuardState = "red" | "green" | "unknown";

export interface GuardStatus {
  key: GuardKey;
  label: string;
  state: GuardState;
  /** One-line summary for the green state (what was checked). */
  summary: string;
  /** Why it is red — empty unless state === "red". */
  reasons: string[];
  /** Epoch seconds of the result this verdict is based on, null when never run. */
  checkedAt: number | null;
}

/** Daily guards: a result older than 36 h means at least one scheduled run was missed. */
export const STALE_AFTER_SECS = 36 * 3600;

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v)) || 0;
const plural = (n: number, one: string, many: string) => `${n} ${n >= 2 ? many : one}`;

function ageLabel(secs: number): string {
  const h = Math.floor(secs / 3600);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} j`;
}

/** Shared tail of every cron-backed guard: failed last run, or no fresh result. */
function runHealth(
  inputs: GuardInputs,
  cronName: string,
  checkedAt: number | null,
  nowSecs: number,
): string[] {
  const reasons: string[] = [];
  const last = inputs.lastRuns[cronName];
  if (last && last.status !== "success" && (checkedAt == null || last.ranAt >= checkedAt)) {
    reasons.push(`le dernier passage a échoué${last.detail ? ` (${last.detail.slice(0, 160)})` : ""}`);
  }
  if (checkedAt != null && nowSecs - checkedAt > STALE_AFTER_SECS) {
    reasons.push(`aucun résultat depuis ${ageLabel(nowSecs - checkedAt)} — le garde-fou ne tourne plus`);
  }
  return reasons;
}

function verdict(
  key: GuardKey,
  label: string,
  checkedAt: number | null,
  reasons: string[],
  summary: string,
  neverRan: boolean,
): GuardStatus {
  if (reasons.length > 0) return { key, label, state: "red", summary, reasons, checkedAt };
  if (neverRan) return { key, label, state: "unknown", summary: "pas encore de résultat", reasons: [], checkedAt: null };
  return { key, label, state: "green", summary, reasons: [], checkedAt };
}

export function evaluateGuards(inputs: GuardInputs, nowSecs: number): GuardStatus[] {
  const out: GuardStatus[] = [];

  // Price floor — below-floor prices are auto-corrected; only a FAILED correction needs a human.
  {
    const a = inputs.priceAudit;
    const checkedAt = a?.auditedAt != null ? num(a.auditedAt) : null;
    const reasons: string[] = [];
    const failed = num(a?.failed);
    if (failed > 0) reasons.push(`${plural(failed, "correction de prix plancher a échoué", "corrections de prix plancher ont échoué")} — prix à corriger à la main`);
    reasons.push(...runHealth(inputs, "price-audit", checkedAt, nowSecs));
    const summary = a
      ? `${num(a.total)} prix vérifiés · ${num(a.corrected)} corrigés automatiquement`
      : "";
    out.push(verdict("price", "Prix plancher", checkedAt, reasons, summary, !a && reasons.length === 0));
  }

  // Catalog consistency — detect-only; any finding is a defect on a live product.
  {
    const a = inputs.catalogAudit;
    const checkedAt = a?.auditedAt != null ? num(a.auditedAt) : null;
    const reasons: string[] = [];
    const en = num(a?.englishDescriptions), brand = num(a?.brandLeaks), dup = num(a?.duplicateColorOptions);
    const found = [
      en && plural(en, "description en anglais", "descriptions en anglais"),
      brand && plural(brand, "fuite de marque fournisseur", "fuites de marque fournisseur"),
      dup && plural(dup, "fiche avec couleur en double", "fiches avec couleur en double"),
    ].filter(Boolean);
    if (found.length) reasons.push(found.join(" · "));
    reasons.push(...runHealth(inputs, "catalog-consistency", checkedAt, nowSecs));
    const summary = a ? `${num(a.totalActive)} fiches actives vérifiées` : "";
    out.push(verdict("catalog", "Cohérence du catalogue", checkedAt, reasons, summary, !a && reasons.length === 0));
  }

  // Image compliance — runs inside the daily sync; a queued review is a decision waiting on Mat.
  {
    const reasons: string[] = [];
    if (inputs.imagesPending > 0) {
      const age = inputs.imagesOldestPendingAt != null ? ` (la plus ancienne depuis ${ageLabel(nowSecs - inputs.imagesOldestPendingAt)})` : "";
      reasons.push(`${plural(inputs.imagesPending, "image attend ta décision", "images attendent ta décision")}${age}`);
    }
    out.push(verdict("images", "Conformité des images", null, reasons, "aucune image en attente de décision", false));
  }

  // Ad feeds — see feed-integrity-audit.ts; the audit persists its own list of red reasons.
  {
    const a = inputs.feedAudit;
    const checkedAt = a?.auditedAt != null ? num(a.auditedAt) : null;
    const reasons: string[] = Array.isArray(a?.reasons) ? (a!.reasons as unknown[]).map(String) : [];
    reasons.push(...runHealth(inputs, "feed-integrity", checkedAt, nowSecs));
    const logic = (a?.logic ?? {}) as Record<string, unknown>;
    const summary = a ? `${num(logic.items)} items vérifiés (${num(logic.multiItems)} multi-variantes)` : "";
    out.push(verdict("feed", "Flux publicitaires", checkedAt, reasons, summary, !a && reasons.length === 0));
  }

  return out;
}

export async function loadGuardStatuses(now: Date = new Date()): Promise<GuardStatus[]> {
  return evaluateGuards(await loadGuardInputs(), Math.floor(now.getTime() / 1000));
}
