"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Storefront assistant (Ameublo / Furni) — abuse protection overview: automatic blocks and
 * today's heaviest visitors. Addresses are salted hashes; the raw IP is never stored.
 */

interface Block {
  ipHash: string;
  blockedUntil: number;
  reason: string;
  strikes: number;
  sample: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Visitor {
  ipHash: string;
  tokens: number;
  messages: number;
  abuseScore: number;
  lastReasons: string | null;
}

interface GuardData {
  blocks: Block[];
  visitors: Visitor[];
  limits: { dailyTokensPerVisitor: number; abuseBlockScore: number };
}

const REASONS: Record<string, string> = {
  jailbreak: "tentative de contourner les consignes",
  long_message: "message très long",
  pasted_payload: "contenu collé (code / liens)",
  repeated_message: "message répété",
  model_abuse: "propos abusifs (selon l'IA)",
  model_off_topic: "hors sujet (selon l'IA)",
};

const fmtReasons = (r: string | null) =>
  (r ?? "")
    .split(",")
    .filter(Boolean)
    .map((x) => REASONS[x] ?? x)
    .join(", ") || "—";

const fmtDate = (t: number) =>
  new Date(t * 1000).toLocaleString("fr-CA", { dateStyle: "short", timeStyle: "short", timeZone: "America/Montreal" });

export default function AssistantGuardPage() {
  const [data, setData] = useState<GuardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/assistant-guard");
      const json = await res.json();
      if (json.success) setData(json.data);
      else setError(json.error || "Chargement impossible");
    } catch {
      setError("Chargement impossible (réseau)");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function unblock(ipHash: string) {
    setBusy(ipHash);
    try {
      await fetch("/api/assistant-guard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unblock", ipHash }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const active = (data?.blocks ?? []).filter((b) => b.blockedUntil > now);
  const past = (data?.blocks ?? []).filter((b) => b.blockedUntil <= now);

  return (
    <div className="max-w-5xl">
      <h2 className="text-2xl font-bold text-white">Assistant — protection</h2>
      <p className="text-gray-400 text-sm mt-1 mb-6">
        Ameublo (FR) / Furni (EN). Chaque visiteur peut dépenser{" "}
        {data?.limits.dailyTokensPerVisitor.toLocaleString("fr-CA") ?? "…"} tokens par jour (une dizaine de conversations, ~20 questions simples). Un score
        d&apos;abus de {data?.limits.abuseBlockScore ?? "…"} points dans la journée bloque l&apos;adresse 24 h, puis 7 jours en
        cas de récidive. Les adresses sont anonymisées (hachées).
      </p>
      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

      <h3 className="text-white font-semibold mb-2">Blocages actifs ({active.length})</h3>
      <BlockTable blocks={active} busy={busy} onUnblock={unblock} empty="Aucune adresse bloquée en ce moment." />

      <h3 className="text-white font-semibold mt-8 mb-2">Plus gros visiteurs aujourd&apos;hui</h3>
      <div className="overflow-x-auto bg-gray-900 border border-gray-800 rounded-lg">
        <table className="w-full text-sm">
          <thead className="text-gray-400 text-left">
            <tr>
              <th className="px-3 py-2">Visiteur</th>
              <th className="px-3 py-2">Messages</th>
              <th className="px-3 py-2">Tokens</th>
              <th className="px-3 py-2">Score d&apos;abus</th>
              <th className="px-3 py-2">Derniers signaux</th>
            </tr>
          </thead>
          <tbody>
            {(data?.visitors ?? []).length === 0 && (
              <tr>
                <td className="px-3 py-3 text-gray-500" colSpan={5}>
                  Aucune conversation aujourd&apos;hui.
                </td>
              </tr>
            )}
            {(data?.visitors ?? []).map((v) => (
              <tr key={v.ipHash} className="border-t border-gray-800 text-gray-200">
                <td className="px-3 py-2 font-mono text-xs">{v.ipHash.slice(0, 10)}…</td>
                <td className="px-3 py-2">{v.messages}</td>
                <td className="px-3 py-2">
                  {v.tokens.toLocaleString("fr-CA")}
                  {data && v.tokens >= data.limits.dailyTokensPerVisitor && (
                    <span className="ml-2 text-amber-400">limite atteinte</span>
                  )}
                </td>
                <td className={`px-3 py-2 ${v.abuseScore > 0 ? "text-amber-400" : ""}`}>{v.abuseScore}</td>
                <td className="px-3 py-2 text-gray-400">{fmtReasons(v.lastReasons)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="text-white font-semibold mt-8 mb-2">Historique des blocages</h3>
      <BlockTable blocks={past} busy={busy} onUnblock={null} empty="Aucun blocage passé." />
    </div>
  );
}

function BlockTable({
  blocks,
  busy,
  onUnblock,
  empty,
}: {
  blocks: Block[];
  busy: string | null;
  onUnblock: ((ipHash: string) => void) | null;
  empty: string;
}) {
  return (
    <div className="overflow-x-auto bg-gray-900 border border-gray-800 rounded-lg">
      <table className="w-full text-sm">
        <thead className="text-gray-400 text-left">
          <tr>
            <th className="px-3 py-2">Visiteur</th>
            <th className="px-3 py-2">Raison</th>
            <th className="px-3 py-2">Récidives</th>
            <th className="px-3 py-2">{onUnblock ? "Bloqué jusqu'au" : "Dernier blocage"}</th>
            <th className="px-3 py-2">Message</th>
            {onUnblock && <th className="px-3 py-2" />}
          </tr>
        </thead>
        <tbody>
          {blocks.length === 0 && (
            <tr>
              <td className="px-3 py-3 text-gray-500" colSpan={onUnblock ? 6 : 5}>
                {empty}
              </td>
            </tr>
          )}
          {blocks.map((b) => (
            <tr key={b.ipHash} className="border-t border-gray-800 text-gray-200 align-top">
              <td className="px-3 py-2 font-mono text-xs">{b.ipHash.slice(0, 10)}…</td>
              <td className="px-3 py-2">{fmtReasons(b.reason)}</td>
              <td className="px-3 py-2">{b.strikes}</td>
              <td className="px-3 py-2 whitespace-nowrap">{fmtDate(onUnblock ? b.blockedUntil : b.updatedAt)}</td>
              <td className="px-3 py-2 text-gray-400 max-w-xs truncate" title={b.sample ?? ""}>
                {b.sample ?? "—"}
              </td>
              {onUnblock && (
                <td className="px-3 py-2">
                  <button
                    onClick={() => onUnblock(b.ipHash)}
                    disabled={busy === b.ipHash}
                    className="px-3 py-1 bg-gray-800 text-gray-200 text-xs rounded hover:bg-gray-700 disabled:opacity-50"
                  >
                    Débloquer
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
