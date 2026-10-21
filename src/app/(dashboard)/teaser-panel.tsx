"use client";

import { useState, useEffect } from "react";

/** Mirrors FunnelRow in src/lib/teaser.ts. */
interface FunnelRow {
  feature: "visualiser" | "decorateur";
  source: "pdp" | "sheet" | "chat";
  views: number;
  clicks: number;
  yes: number;
  no: number;
  emails: number;
  clickRate: number | null;
  yesRate: number | null;
}

const LABEL: Record<FunnelRow["feature"], string> = {
  visualiser: "Voyez-le chez vous",
  decorateur: "Ameublo décorateur",
};
const SOURCE: Record<FunnelRow["source"], string> = {
  pdp: "bouton sur la photo produit",
  sheet: "lien dans la fenêtre « Voyez-le chez vous »",
  chat: "bouton dans l'assistant",
};
const pct = (n: number | null) => (n == null ? "—" : `${n.toLocaleString("fr-CA")} %`);

/**
 * "Bientôt" teasers: unique visitors per step, per feature and entry point (GET /api/dashboard/teasers). The decision
 * signal Mat asked for — do people click, and do they say yes?
 */
export function TeaserPanel() {
  const [rows, setRows] = useState<FunnelRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard/teasers?days=30")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        if (d && Array.isArray(d.funnel)) setRows(d.funnel);
        else setError(true);
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-white">Fonctions « bientôt » — intérêt des clients</h3>
        <span className="text-xs text-gray-500">30 derniers jours · visiteurs uniques</span>
      </div>
      {error ? (
        <div className="p-4 bg-red-950/30 border border-red-800/50 rounded-xl text-sm text-red-300">Impossible de charger les résultats.</div>
      ) : rows == null ? (
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl text-sm text-gray-400">Chargement…</div>
      ) : rows.length === 0 ? (
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl text-sm text-gray-400">Aucune donnée pour l&apos;instant.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {rows.map((r) => (
            <div key={`${r.feature}-${r.source}`} className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
              <p className="text-sm font-semibold text-white">{LABEL[r.feature]}</p>
              <p className="text-xs text-gray-500 mb-3">{SOURCE[r.source]}</p>
              <dl className="grid grid-cols-5 gap-2 text-center tabular-nums">
                {([["Vu", r.views], ["Cliqué", r.clicks], ["Oui", r.yes], ["Non", r.no], ["Courriel", r.emails]] as const).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-[11px] text-gray-500">{k}</dt>
                    <dd className="text-lg font-semibold text-white">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-[11px] text-gray-400 mt-2">{`Taux de clic ${pct(r.clickRate)} · « oui » parmi les réponses ${pct(r.yesRate)}`}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
