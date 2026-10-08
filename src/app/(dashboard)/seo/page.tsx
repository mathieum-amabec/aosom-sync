"use client";

import { useCallback, useEffect, useState } from "react";
import type { SeoSummary } from "@/lib/gsc-sync";

/**
 * SEO — what Google Search Console says about the site: clicks, impressions, click-through rate and average position
 * (last 28 days vs the 28 before), by section (guides, blog, products, collections), top pages and queries, and blog/guide
 * pages that get seen but not clicked. Data comes from the daily import (/api/cron/gsc-sync); Search Console lags ~2 days.
 */

interface Payload {
  configured: boolean;
  missing: string[];
  summary: SeoSummary;
}

const fmtInt = (n: number) => Math.round(n).toLocaleString("fr-CA");
const fmtPct = (n: number) => `${(n * 100).toFixed(1).replace(".", ",")} %`;
const fmtPos = (n: number) => (n ? n.toFixed(1).replace(".", ",") : "—");
const shortUrl = (u: string) => {
  try {
    const x = new URL(u);
    return (x.pathname + x.search).slice(0, 70) || "/";
  } catch {
    return u.slice(0, 70);
  }
};

function Delta({ cur, prev, lowerIsBetter = false }: { cur: number; prev: number; lowerIsBetter?: boolean }) {
  if (!prev) return <span className="text-xs text-gray-500">—</span>;
  const pct = ((cur - prev) / prev) * 100;
  const good = lowerIsBetter ? pct < 0 : pct > 0;
  return <span className={`text-xs ${Math.abs(pct) < 0.5 ? "text-gray-500" : good ? "text-emerald-400" : "text-red-400"}`}>{pct > 0 ? "+" : ""}{pct.toFixed(0)} % vs période précédente</span>;
}

function Kpi({ label, value, extra }: { label: string; value: string; extra: React.ReactNode }) {
  return (
    <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-2xl font-semibold text-white">{value}</div>
      {extra}
    </div>
  );
}

function Table({ title, head, rows }: { title: string; head: string[]; rows: Array<Array<string | number>> }) {
  return (
    <section className="p-4 bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto">
      <h2 className="text-base font-semibold text-white mb-2">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">Rien à afficher pour l&apos;instant.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 text-xs">{head.map((h, i) => <th key={h} className={`py-1 pr-3 font-medium ${i > 0 ? "text-right" : ""}`}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-gray-800 text-gray-300">
                {r.map((c, j) => <td key={j} className={`py-1.5 pr-3 ${j > 0 ? "text-right tabular-nums" : "break-all"}`}>{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Setup({ missing }: { missing: string[] }) {
  return (
    <section className="p-5 bg-gray-900 border border-amber-800/50 rounded-xl">
      <h2 className="text-lg font-semibold text-white mb-1">Google Search Console n&apos;est pas encore connecté</h2>
      <p className="text-sm text-gray-400 mb-3">Il manque: {missing.join(", ")}. Quatre étapes, environ dix minutes, avec le compte Google qui gère le site:</p>
      <ol className="list-decimal pl-5 space-y-1.5 text-sm text-gray-300">
        <li>Google Cloud Console → <em>API et services</em> → activer <strong>Google Search Console API</strong>.</li>
        <li><em>IAM et administration → Comptes de service</em> → créer un compte (ex. <code>aosom-sync-gsc</code>) → onglet <em>Clés</em> → <em>Ajouter une clé</em> → JSON (un fichier se télécharge).</li>
        <li>Search Console → la propriété du site → <em>Paramètres → Utilisateurs et autorisations</em> → <em>Ajouter un utilisateur</em> → l&apos;adresse du compte de service (<code>…@…iam.gserviceaccount.com</code>), autorisation <strong>Restreint</strong>.</li>
        <li>Vercel → projet → <em>Settings → Environment Variables</em> → <code>GSC_SERVICE_ACCOUNT_JSON</code> (tout le contenu du fichier JSON) et <code>GSC_SITE_URL</code> (<code>sc-domain:ameublodirect.ca</code> pour une propriété de domaine, ou <code>https://ameublodirect.ca/</code>), puis redéployer.</li>
      </ol>
      <p className="text-xs text-gray-500 mt-3">Le fichier JSON est un mot de passe: ne le collez pas dans une conversation et ne le versionnez pas.</p>
    </section>
  );
}

export default function SeoPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(28);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/seo/summary?days=${days}`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j.data as Payload);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur de chargement");
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">SEO — Google</h1>
        {error ? <div className="p-4 bg-red-950/30 border border-red-800/50 rounded-xl text-sm text-red-300">{error}</div> : <p className="text-sm text-gray-400">Chargement…</p>}
      </div>
    );
  }

  const s = data.summary;

  return (
    <div className="p-6 max-w-6xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">SEO — Google</h1>
          <p className="text-sm text-gray-400 mt-1">
            Ce que Google Search Console voit de votre site.{s.lastDay ? ` Données jusqu'au ${s.lastDay} (Google a environ 2 jours de retard).` : ""}
          </p>
        </div>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="bg-gray-950 border border-gray-700 text-sm text-gray-200 rounded-lg px-2 py-1.5" aria-label="Période">
          {[7, 28, 90].map((d) => <option key={d} value={d}>{d} derniers jours</option>)}
        </select>
      </div>

      {!data.configured && <Setup missing={data.missing} />}
      {data.configured && !s.lastDay && (
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl text-sm text-gray-300">
          Connecté, en attente de la première importation (elle roule chaque jour). Pour importer l&apos;historique tout de suite, dites-moi « importe 90 jours » ou appelez <code>/api/cron/gsc-sync?backfill=90</code>.
        </div>
      )}

      {s.lastDay && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi label="Clics" value={fmtInt(s.current.clicks)} extra={<Delta cur={s.current.clicks} prev={s.previous.clicks} />} />
            <Kpi label="Impressions" value={fmtInt(s.current.impressions)} extra={<Delta cur={s.current.impressions} prev={s.previous.impressions} />} />
            <Kpi label="Taux de clic" value={fmtPct(s.current.ctr)} extra={<Delta cur={s.current.ctr} prev={s.previous.ctr} />} />
            <Kpi label="Position moyenne" value={fmtPos(s.current.position)} extra={<Delta cur={s.current.position} prev={s.previous.position} lowerIsBetter />} />
          </div>

          <Table
            title="Par type de page"
            head={["Section", "Pages", "Clics", "Impressions", "Taux de clic", "Position"]}
            rows={s.sections.map((x) => [x.section, x.pages, fmtInt(x.clicks), fmtInt(x.impressions), fmtPct(x.ctr), fmtPos(x.position)])}
          />
          <div className="grid md:grid-cols-2 gap-4">
            <Table title="Pages les plus performantes" head={["Page", "Clics", "Impr."]} rows={s.topPages.map((p) => [shortUrl(p.page), fmtInt(p.clicks), fmtInt(p.impressions)])} />
            <Table title="Requêtes les plus fréquentes" head={["Requête", "Clics", "Impr.", "Pos."]} rows={s.topQueries.map((q) => [q.query, fmtInt(q.clicks), fmtInt(q.impressions), fmtPos(q.position)])} />
          </div>
          <Table
            title="Articles et guides vus mais jamais cliqués (titre ou description à améliorer)"
            head={["Page", "Impr.", "Position"]}
            rows={s.contentOpportunities.map((o) => [shortUrl(o.page), fmtInt(o.impressions), fmtPos(o.position)])}
          />
        </>
      )}
      {error && <div className="p-3 bg-red-950/30 border border-red-800/50 rounded-xl text-sm text-red-300">{error}</div>}
    </div>
  );
}
