"use client";

import { useState, useEffect } from "react";

interface PoolUsage {
  pool: "assistant" | "batch";
  model: string;
  tokens: number;
  budget: number;
  pctOfBudget: number;
  costUsd: number;
  blendedRatePerMTok: number;
  assumedInputShare: number;
}
interface DayUsage {
  day: string;
  assistant: number;
  batch: number;
  costUsd: number;
}
interface Usage {
  pools: PoolUsage[];
  days: DayUsage[];
  windowCostUsd: number;
  todayCostUsd: number;
}

const POOL_LABEL: Record<PoolUsage["pool"], string> = {
  assistant: "Assistant (boutique)",
  batch: "Batch (imports, blog, social)",
};

/** Amber at 80% of the daily cap, red at 100% — matches the alert colours used elsewhere. */
function budgetTone(pct: number): { bar: string; text: string; border: string } {
  if (pct >= 100) return { bar: "bg-red-500", text: "text-red-300", border: "border-red-800/50" };
  if (pct >= 80) return { bar: "bg-amber-500", text: "text-amber-300", border: "border-amber-800/50" };
  return { bar: "bg-blue-500", text: "text-gray-400", border: "border-gray-800" };
}

/** Bar-chart height in px. Bars are sized against this rather than with percentages. */
const CHART_HEIGHT_PX = 96;

const fmtTokens = (n: number) => n.toLocaleString("en-CA");
const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("fr-CA", { weekday: "short", timeZone: "UTC" });

export function LlmUsagePanel() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard/llm-usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        if (!d || d.error) { setError(true); return; }
        setUsage(d as Usage);
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <section className="mb-8">
        <h3 className="text-lg font-semibold text-white mb-3">Consommation API</h3>
        <div className="p-6 bg-gray-900 border border-gray-800 rounded-xl flex items-center gap-3">
          <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-gray-400">Chargement…</span>
        </div>
      </section>
    );
  }

  if (error || !usage) {
    return (
      <section className="mb-8">
        <h3 className="text-lg font-semibold text-white mb-3">Consommation API</h3>
        <div className="p-4 bg-red-950/30 border border-red-800/50 rounded-xl text-sm text-red-300">
          Impossible de charger la consommation API.
        </div>
      </section>
    );
  }

  const maxDayTokens = Math.max(1, ...usage.days.map((d) => d.assistant + d.batch));
  const atRisk = usage.pools.filter((p) => p.pctOfBudget >= 80);

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-white">Consommation API</h3>
        <span className="text-xs text-gray-500">
          {fmtUsd(usage.todayCostUsd)} aujourd&apos;hui · {fmtUsd(usage.windowCostUsd)} sur 7 j (estimé)
        </span>
      </div>

      {atRisk.length > 0 && (
        <div
          className={`mb-3 p-3 rounded-xl border text-sm ${
            atRisk.some((p) => p.pctOfBudget >= 100)
              ? "bg-red-950/30 border-red-800/50 text-red-300"
              : "bg-amber-950/30 border-amber-800/50 text-amber-300"
          }`}
        >
          {atRisk.map((p) => (
            <div key={p.pool}>
              {p.pctOfBudget >= 100
                ? `Le pool « ${POOL_LABEL[p.pool]} » a atteint son plafond quotidien — les appels échouent jusqu'à 00:00 UTC.`
                : `Le pool « ${POOL_LABEL[p.pool]} » est à ${p.pctOfBudget} % de son plafond quotidien.`}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        {usage.pools.map((p) => {
          const tone = budgetTone(p.pctOfBudget);
          return (
            <div key={p.pool} className={`p-4 bg-gray-900 border rounded-xl ${tone.border}`}>
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-xs text-gray-500">{POOL_LABEL[p.pool]}</p>
                <span className="text-[11px] text-gray-600 font-mono">{p.model}</span>
              </div>
              <p className="text-xl font-semibold text-white mt-1 tabular-nums">
                {fmtTokens(p.tokens)}
                <span className="text-sm font-normal text-gray-500"> / {fmtTokens(p.budget)} tokens</span>
              </p>
              <div className="h-1.5 bg-gray-800 rounded-full mt-2 overflow-hidden">
                <div className={`h-full ${tone.bar}`} style={{ width: `${p.pctOfBudget}%` }} />
              </div>
              {/* Built as one string: adjacent JSX text after an expression loses its
                  leading space here, which rendered "$0.00estimé". */}
              <p className={`text-[11px] mt-1.5 ${tone.text}`}>
                {`${p.pctOfBudget} % du plafond · ${fmtUsd(p.costUsd)} estimé aujourd'hui`}
              </p>
            </div>
          );
        })}
      </div>

      <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
        <p className="text-xs text-gray-500 mb-3">7 derniers jours (UTC)</p>
        {/* Bars are sized in PIXELS against CHART_HEIGHT_PX, not in percent. A percentage
            height needs a parent with a definite height; inside this auto-height flex
            column it resolved to zero and every bar rendered invisible. Labels live in
            their own row so the bar row keeps a fixed height. */}
        <div className="flex items-end gap-2" style={{ height: CHART_HEIGHT_PX }}>
          {usage.days.map((d) => {
            const total = d.assistant + d.batch;
            // Floor a non-zero value at 2px so a small day is visible rather than rounded away.
            const px = (n: number) =>
              n <= 0 ? 0 : Math.max(2, Math.round((n / maxDayTokens) * CHART_HEIGHT_PX));
            return (
              <div
                key={d.day}
                className="flex-1 flex flex-col justify-end min-w-0"
                title={`${d.day} — assistant ${fmtTokens(d.assistant)}, batch ${fmtTokens(d.batch)} · ${fmtUsd(d.costUsd)} estimé`}
              >
                <div className="w-full bg-blue-500/80 rounded-t-sm" style={{ height: px(d.assistant) }} />
                <div className="w-full bg-amber-500/80" style={{ height: px(d.batch) }} />
                {total === 0 && <div className="w-full h-px bg-gray-700" />}
              </div>
            );
          })}
        </div>
        <div className="flex gap-2 mt-1">
          {usage.days.map((d) => (
            <span key={d.day} className="flex-1 text-[10px] text-gray-600 text-center truncate min-w-0">
              {dayLabel(d.day)}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-4 mt-3 text-[11px] text-gray-500">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-blue-500/80" /> Assistant
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-amber-500/80" /> Batch
          </span>
        </div>
        {/* Two caveats an operator needs before trusting a dollar figure or an empty bar. */}
        <p className="text-[11px] text-gray-600 mt-3 leading-relaxed">
          Coûts estimés : le compteur ne stocke qu&apos;un total entrée+sortie par jour, donc la
          répartition est supposée ({usage.pools.map((p) => `${POOL_LABEL[p.pool].split(" ")[0]} ${Math.round(p.assumedInputShare * 100)} % entrée`).join(", ")}).
          Une journée à zéro signifie qu&apos;aucun appel n&apos;a <em>réussi</em>
          {" — le compteur ne s'incrémente qu'après une réponse valide, donc une clé bloquée ressemble à une journée inactive. " +
            "Les journées passées sont chiffrées au tarif du modèle actuel de chaque pool : celles antérieures à un changement de modèle sont donc approximatives."}
        </p>
      </div>
    </section>
  );
}
