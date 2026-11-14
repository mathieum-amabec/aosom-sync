"use client";

import { useCallback, useEffect, useState } from "react";
import type { AutomationStatus, CronLine } from "@/lib/automation-controls";

/**
 * Automatisations — one place to stop (and watch) the things that run by themselves: the daily catalogue
 * import, the automatic publications (Facebook / Instagram / blog / guides) and "La semaine Ameublo".
 * Every switch is a setting read on the next cron tick: a pause is immediate and nothing queued is deleted.
 */

type Mode = "off" | "dry" | "pilot" | "live";
const MODE_LABEL: Record<Mode, string> = {
  off: "Arrêté",
  dry: "Simulation (n'écrit rien)",
  pilot: "Pilote (10 brouillons)",
  live: "En direct",
};

const TZ = "America/Montreal";
const fmtSqlUtc = (s: string | null) =>
  s ? new Date(s.replace(" ", "T") + (s.includes("Z") ? "" : "Z")).toLocaleString("fr-CA", { timeZone: TZ, dateStyle: "short", timeStyle: "short" }) : "—";
const fmtEpoch = (t: number) => (t ? new Date(t * 1000).toLocaleString("fr-CA", { timeZone: TZ, dateStyle: "short", timeStyle: "short" }) : "jamais");
const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)} M` : n >= 1_000 ? `${Math.round(n / 1_000)} k` : String(n));

function Pill({ on, label }: { on: boolean; label?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${on ? "bg-emerald-900/50 text-emerald-300 border border-emerald-800/60" : "bg-amber-900/40 text-amber-300 border border-amber-800/60"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${on ? "bg-emerald-400" : "bg-amber-400"}`} />
      {label ?? (on ? "En marche" : "En pause")}
    </span>
  );
}

function LastRun({ run }: { run: CronLine | null }) {
  if (!run) return <p className="text-xs text-gray-500">Aucune exécution enregistrée.</p>;
  return (
    <p className={`text-xs ${run.status === "success" ? "text-gray-400" : "text-red-300"}`}>
      Dernier passage: {fmtEpoch(run.ranAt)} · {run.status === "success" ? "OK" : "ERREUR"}
      {run.detail ? ` — ${run.detail}` : ""}
    </p>
  );
}

function Stat({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className="px-3 py-2 bg-gray-950/60 border border-gray-800 rounded-lg">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-lg font-semibold ${warn ? "text-red-300" : "text-white"}`}>{value}</div>
    </div>
  );
}

function Card({ title, desc, on, pillLabel, action, children }: { title: string; desc: string; on: boolean; pillLabel?: string; action: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="p-5 bg-gray-900 border border-gray-800 rounded-xl">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-lg font-semibold text-white">{title}</h2>
            <Pill on={on} label={pillLabel} />
          </div>
          <p className="text-sm text-gray-400 mt-1 max-w-2xl">{desc}</p>
        </div>
        <div className="flex items-center gap-2">{action}</div>
      </div>
      {children}
    </section>
  );
}

export default function AutomationsPage() {
  const [data, setData] = useState<AutomationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/automations", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j.data as AutomationStatus);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur de chargement");
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function change(key: "auto_import" | "publisher" | "semaine" | "all", enabled: boolean, mode?: Mode, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      const res = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, enabled, ...(mode ? { mode } : {}) }),
      });
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j.data as AutomationStatus);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Échec du changement");
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Automatisations</h1>
        {error ? <div className="p-4 bg-red-950/30 border border-red-800/50 rounded-xl text-sm text-red-300">{error}</div> : <p className="text-sm text-gray-400">Chargement…</p>}
      </div>
    );
  }

  const { autoImport: imp, publisher: pub, semaine: sem } = data;
  const allOn = imp.on || !pub.paused || sem.on;
  const btn = "px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-white">Automatisations</h1>
          <p className="text-sm text-gray-400 mt-1">Arrêtez ou relancez ce qui tourne tout seul, et voyez ce qu&apos;il a fait. Un arrêt est immédiat et ne supprime rien.</p>
        </div>
        <button
          disabled={busy}
          onClick={() =>
            allOn
              ? change("all", false, undefined, "Tout arrêter: importation automatique, publications automatiques et La semaine Ameublo. Rien n'est supprimé. Continuer?")
              : change("all", true, undefined, "Tout reprendre? L'importation reprend dans son dernier mode.")
          }
          className={`${btn} ${allOn ? "bg-red-600 hover:bg-red-500 text-white" : "bg-emerald-600 hover:bg-emerald-500 text-white"}`}
        >
          {allOn ? "Tout arrêter" : "Tout reprendre"}
        </button>
      </div>

      {error && <div className="mb-4 p-3 bg-red-950/30 border border-red-800/50 rounded-xl text-sm text-red-300">{error}</div>}

      <div className="space-y-4">
        <Card
          title="Importation automatique"
          desc="Importe chaque jour de nouveaux produits (nouveautés d'abord, puis jouets et autres catégories) après vérification du texte, du titre, des photos et des couleurs."
          on={imp.on}
          pillLabel={imp.on ? MODE_LABEL[imp.mode] : "Arrêtée"}
          action={
            <>
              <select
                disabled={busy}
                value={imp.mode}
                onChange={(e) => change("auto_import", e.target.value !== "off", e.target.value as Mode)}
                className="bg-gray-950 border border-gray-700 text-sm text-gray-200 rounded-lg px-2 py-1.5"
                aria-label="Mode de l'importation automatique"
              >
                {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
                  <option key={m} value={m}>{MODE_LABEL[m]}</option>
                ))}
              </select>
              <button
                disabled={busy}
                onClick={() => (imp.on ? change("auto_import", false, undefined, "Arrêter l'importation automatique? Les produits déjà créés restent en place.") : change("auto_import", true))}
                className={`${btn} ${imp.on ? "bg-red-600 hover:bg-red-500 text-white" : "bg-emerald-600 hover:bg-emerald-500 text-white"}`}
              >
                {imp.on ? "Arrêter" : imp.resumeMode ? `Reprendre (${MODE_LABEL[imp.resumeMode]})` : "Reprendre (simulation)"}
              </button>
            </>
          }
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            <Stat label="Importés aujourd'hui" value={`${imp.today?.imported ?? 0} / ${imp.dailyCap}`} />
            <Stat label="Dont jouets" value={imp.today?.toys ?? 0} />
            <Stat label="À revoir (24 h)" value={imp.last24h.needsReview} warn={imp.last24h.needsReview > 0} />
            <Stat label="Erreurs (24 h)" value={imp.last24h.error} warn={imp.last24h.error > 0} />
          </div>
          <p className="text-xs text-gray-400 mb-1">
            Jetons IA du pool « import » aujourd&apos;hui: {fmtTokens(imp.llm.used)} / {fmtTokens(imp.llm.budget)} · Importés avec succès (24 h): {imp.last24h.done}
          </p>
          <LastRun run={imp.lastRun} />
          {imp.recentProblems.length > 0 && (
            <div className="mt-3">
              <h3 className="text-sm font-medium text-gray-300 mb-1">Produits à revoir ou en erreur (24 h)</h3>
              <ul className="space-y-1">
                {imp.recentProblems.map((p) => (
                  <li key={p.groupKey + p.at} className="text-xs text-gray-400 border-l-2 border-amber-700/70 pl-2">
                    <span className="text-gray-200">{p.groupKey}</span> · {p.status === "error" ? "erreur" : "à revoir"} · {fmtSqlUtc(p.at)}
                    <div className="text-gray-500 break-words">{p.reason || "—"}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card
          title="Publications automatiques"
          desc="Facebook, Instagram, blog et guides: la file de publication, les publications automatiques des baisses de prix et la mise en ligne automatique des articles de blog. En pause, rien ne sort; tout reste en attente."
          on={!pub.paused}
          action={
            <button
              disabled={busy}
              onClick={() => (pub.paused ? change("publisher", true) : change("publisher", false, undefined, "Mettre en pause TOUTES les publications automatiques (Facebook, Instagram, blog, guides)? Les publications restent en attente et sortiront à la reprise."))}
              className={`${btn} ${pub.paused ? "bg-emerald-600 hover:bg-emerald-500 text-white" : "bg-red-600 hover:bg-red-500 text-white"}`}
            >
              {pub.paused ? "Reprendre" : "Mettre en pause"}
            </button>
          }
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            <Stat label="En attente" value={pub.pending} />
            <Stat label="En retard" value={pub.overdue} warn={pub.overdue > 0 && !pub.paused} />
            <Stat label="Échecs (3 j)" value={pub.failed3d} warn={pub.failed3d > 0} />
            <Stat label="Prochaine" value={fmtSqlUtc(pub.next)} />
          </div>
          <p className="text-xs text-gray-400 mb-1">Dernière publication: {fmtSqlUtc(pub.lastPublishedAt)}</p>
          <LastRun run={pub.lastRun} />
          {pub.paused && <p className="mt-2 text-xs text-amber-300">En pause: {pub.overdue} publication(s) due(s) attendent la reprise.</p>}
        </Card>

        <Card
          title="La semaine Ameublo"
          desc="Planifie automatiquement les photos Facebook et Instagram du jour. Arrêtée, plus aucune nouvelle photo n'est mise en file (celles déjà en file suivent l'interrupteur des publications)."
          on={sem.on}
          action={
            <button
              disabled={busy}
              onClick={() => (sem.on ? change("semaine", false, undefined, "Arrêter La semaine Ameublo? Plus aucune nouvelle photo ne sera planifiée.") : change("semaine", true))}
              className={`${btn} ${sem.on ? "bg-red-600 hover:bg-red-500 text-white" : "bg-emerald-600 hover:bg-emerald-500 text-white"}`}
            >
              {sem.on ? "Arrêter" : "Reprendre"}
            </button>
          }
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            <Stat label="Photos en file" value={sem.pending} />
          </div>
          <LastRun run={sem.lastRun} />
        </Card>
      </div>

      <p className="mt-4 text-xs text-gray-500">
        Mis à jour: {fmtSqlUtc(data.generatedAt.replace("T", " ").replace("Z", ""))} (actualisation automatique toutes les 30 s)
        {data.lastChange ? ` · Dernier changement: ${data.lastChange.key} ${data.lastChange.enabled ? "activé" : "arrêté"} par ${data.lastChange.by}, ${fmtSqlUtc(data.lastChange.at.replace("T", " ").replace("Z", ""))}` : ""}
      </p>
    </div>
  );
}
