"use client";

import { useState, useEffect } from "react";

/** Mirrors GET /api/email/status. */
interface EmailStatus {
  mode: "off" | "test" | "live";
  problems: string[];
  testRecipients: string[];
  mailingAddress: string;
  groups: Array<{ group: string; flows: Array<{ key: string; consent: "express" | "own" }>; since: string | null }>;
  stats: Array<{ flow: string; status: string; n: number }>;
  suppressions: Record<string, number>;
}

const MODE: Record<EmailStatus["mode"], string> = { off: "Éteint", test: "Test", live: "En marche" };
const GROUP: Record<string, string> = {
  relance: "Paiement abandonné",
  bienvenue: "Bienvenue (infolettre)",
  roue: "Roue de bienvenue",
  avis: "Demande d'avis",
  "baisse-prix": "Baisse de prix",
};
const FLOW: Record<string, string> = {
  "relance-1": "Rappel 1 (30 min)", "relance-2": "Rappel 2 (24 h)",
  "bienvenue-1": "Code BIENVENUE20", "bienvenue-2": "Notre histoire (3 jours)",
  "roue-1": "Ton code", "roue-2": "Expire dans 48 h", "roue-3": "Dernières heures",
  avis: "10 jours après l'expédition", "baisse-prix": "Le prix a baissé",
};
const STATUS: Record<string, string> = { sent: "Envoyés", delivered: "Livrés", opened: "Ouverts", clicked: "Cliqués", bounced: "Rebonds", complained: "Plaintes", failed: "Échecs" };
const SUPPRESSION: Record<string, string> = { unsubscribe: "désabonnés", bounce: "adresses invalides", complaint: "plaintes" };

/**
 * Our own email engine (Resend): switch, missing setup, previews of every email, which flows moved
 * off the Klaviyo relays, and 30-day results. Everything stays off until Mat switches it on.
 */
export function EmailPanel() {
  const [s, setS] = useState<EmailStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);
  const [address, setAddress] = useState("");
  const [tests, setTests] = useState("");

  const load = (d: EmailStatus) => { setS(d); setAddress(d.mailingAddress); setTests(d.testRecipients.join(", ")); };

  useEffect(() => {
    let cancelled = false;
    fetch("/api/email/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) { if (d && Array.isArray(d.groups)) load(d); else setError("Impossible de charger l'état des courriels."); } })
      .catch(() => { if (!cancelled) setError("Impossible de charger l'état des courriels."); });
    return () => { cancelled = true; };
  }, []);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/email/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(d.groups)) load(d);
      else setError(d.error ?? "Erreur");
    } catch {
      setError("Erreur réseau");
    } finally {
      setBusy(false);
      setConfirmLive(false);
    }
  }

  const count = (flow: string, status: string) => s?.stats.find((x) => x.flow === flow && x.status === status)?.n ?? 0;

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-white">Courriels automatiques (Resend)</h3>
        {s && <span className={`text-xs px-2 py-1 rounded-full ${s.mode === "live" ? "bg-green-900/60 text-green-300" : s.mode === "test" ? "bg-amber-900/60 text-amber-300" : "bg-gray-800 text-gray-400"}`}>{MODE[s.mode]}</span>}
      </div>
      {error && <div className="mb-3 p-3 bg-red-950/30 border border-red-800/50 rounded-xl text-sm text-red-300">{error}</div>}
      {!s ? (
        !error && <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl text-sm text-gray-400">Chargement…</div>
      ) : (
        <div className="space-y-3">
          {s.problems.length > 0 && (
            <div className="p-4 bg-gray-900 border border-amber-800/50 rounded-xl text-sm">
              <p className="font-semibold text-amber-300 mb-1">À faire avant le premier envoi</p>
              <ul className="list-disc pl-5 text-gray-300 space-y-0.5">{s.problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}

          <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl text-sm space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-gray-400 mr-1">Interrupteur :</span>
              {(["off", "test", "live"] as const).map((m) => (
                <button key={m} disabled={busy || s.mode === m}
                  onClick={() => (m === "live" ? setConfirmLive(true) : post({ action: "mode", mode: m }))}
                  className={`px-3 py-1.5 rounded-lg border ${s.mode === m ? "border-white text-white" : "border-gray-700 text-gray-300 hover:border-gray-500"} disabled:opacity-60`}>
                  {MODE[m]}
                </button>
              ))}
            </div>
            {confirmLive && (
              <div className="p-3 border border-green-800/60 rounded-lg bg-green-950/30">
                <p className="text-gray-200 mb-2">Les groupes cochés « repris » partiront aux vrais clients par Resend, et les relais Klaviyo arrêteront de les envoyer. Confirmer ?</p>
                <div className="flex gap-2">
                  <button disabled={busy} onClick={() => post({ action: "mode", mode: "live" })} className="px-3 py-1.5 rounded-lg bg-green-700 text-white">Oui, mettre en marche</button>
                  <button onClick={() => setConfirmLive(false)} className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300">Annuler</button>
                </div>
              </div>
            )}
            <label className="block">
              <span className="text-gray-400">Adresse postale du pied de page (exigée par la loi)</span>
              <div className="flex gap-2 mt-1">
                <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="ex. C.P. 123, Saint-Hubert QC J3Y 0A1" className="flex-1 min-w-0 px-3 py-1.5 bg-gray-950 border border-gray-700 rounded-lg text-white" />
                <button disabled={busy} onClick={() => post({ action: "address", value: address })} className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300">Enregistrer</button>
              </div>
            </label>
            <label className="block">
              <span className="text-gray-400">Adresses de test (mode Test seulement)</span>
              <div className="flex gap-2 mt-1">
                <input value={tests} onChange={(e) => setTests(e.target.value)} placeholder="toi@exemple.ca" className="flex-1 min-w-0 px-3 py-1.5 bg-gray-950 border border-gray-700 rounded-lg text-white" />
                <button disabled={busy} onClick={() => post({ action: "test-recipients", value: tests })} className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300">Enregistrer</button>
              </div>
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {s.groups.map((g) => (
              <div key={g.group} className="p-4 bg-gray-900 border border-gray-800 rounded-xl text-sm">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <p className="font-semibold text-white">{GROUP[g.group] ?? g.group}</p>
                  <label className="flex items-center gap-2 text-xs text-gray-400">
                    <input type="checkbox" checked={!!g.since} disabled={busy} onChange={(e) => post({ action: "takeover", group: g.group, on: e.target.checked })} />
                    Repris par Resend
                  </label>
                </div>
                <ul className="space-y-1.5">
                  {g.flows.map((f) => (
                    <li key={f.key} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-gray-300">{FLOW[f.key] ?? f.key}</span>
                      <span className="flex gap-2 text-xs">
                        <a href={`/api/email/preview?flow=${f.key}&locale=fr`} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">Aperçu FR</a>
                        <a href={`/api/email/preview?flow=${f.key}&locale=en`} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">EN</a>
                      </span>
                      {count(f.key, "sent") + count(f.key, "delivered") + count(f.key, "opened") + count(f.key, "clicked") > 0 && (
                        <span className="w-full text-[11px] text-gray-500 tabular-nums">
                          {Object.keys(STATUS).map((st) => `${STATUS[st]} ${count(f.key, st)}`).join(" · ")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-500">
            {Object.keys(s.suppressions).length
              ? `Ne recevront plus de promotions : ${Object.entries(s.suppressions).map(([k, n]) => `${n} ${SUPPRESSION[k] ?? k}`).join(", ")}.`
              : "Aucun désabonnement pour l'instant."}
            {" "}Tant que l&apos;interrupteur n&apos;est pas « En marche », les relais Klaviyo continuent d&apos;envoyer tous les courriels.
          </p>
        </div>
      )}
    </section>
  );
}
