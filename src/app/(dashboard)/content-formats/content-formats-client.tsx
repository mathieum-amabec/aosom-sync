"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * /content-formats — Étape 4 of the content-scale chantier: one page, one tab per new
 * batch format (Demand-Gen élargi / Avant-Après / Assembly), so these don't get mixed into
 * /videos or /demand-gen-videos (which cover the pre-existing, already-shipped formats).
 * Deliberately plain — a table per tab, same visual language as demand-gen-videos-client.tsx
 * (dark cards, small status pills), no new visual system.
 */

type ContentType = "demand_gen_ext" | "before_after" | "assembly";

const TABS: { type: ContentType; label: string }[] = [
  { type: "demand_gen_ext", label: "Demand-Gen élargi" },
  { type: "before_after", label: "Avant-Après" },
  { type: "assembly", label: "Assembly" },
];

interface Item {
  id: number;
  contentType: ContentType;
  sku: string;
  status: string;
  scheduledAt: string;
  publishedAt: string | null;
  createdAt: string;
  payload: { productName?: string; blobUrl?: string; price?: number; ratio?: string; durationSec?: number };
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  draft: { label: "📝 Brouillon", cls: "bg-gray-800 text-gray-300 border-gray-700" },
  pending: { label: "⏳ Planifié", cls: "bg-blue-900/40 text-blue-300 border-blue-800/50" },
  publishing: { label: "📤 Publication…", cls: "bg-blue-900/40 text-blue-300 border-blue-800/50" },
  published: { label: "✅ Publié", cls: "bg-green-900/40 text-green-300 border-green-800/50" },
  failed: { label: "❌ Échec", cls: "bg-red-950/40 text-red-300 border-red-800/50" },
  cancelled: { label: "🚫 Annulé", cls: "bg-gray-800 text-gray-500 border-gray-700" },
};

function formatSlot(sqliteUtc: string): string {
  const d = new Date(`${sqliteUtc.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? sqliteUtc : d.toLocaleString("fr-CA", { dateStyle: "medium", timeStyle: "short" });
}

/** 24h-from-now floor, as the 'YYYY-MM-DDTHH:MM' <input type="datetime-local"> needs. */
function earliestSlotValue(now: Date = new Date()): string {
  const d = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function ContentFormatsClient() {
  const [tab, setTab] = useState<ContentType>("demand_gen_ext");
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [msg, setMsg] = useState<Record<number, string>>({});

  const load = useCallback(async (type: ContentType) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/content-batches/queue?type=${type}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Erreur ${res.status}`);
      setItems(json.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur réseau");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(tab);
  }, [tab, load]);

  async function approve(item: Item, scheduledAt?: string) {
    setBusy((s) => ({ ...s, [item.id]: true }));
    setMsg((s) => ({ ...s, [item.id]: "" }));
    try {
      const res = await fetch("/api/content-batches/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queueId: item.id, contentType: item.contentType, ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}) }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMsg((s) => ({ ...s, [item.id]: json.error || `Erreur ${res.status}` }));
        return;
      }
      setMsg((s) => ({ ...s, [item.id]: `Planifié ${formatSlot(json.scheduledAt)}` }));
      load(tab);
    } catch {
      setMsg((s) => ({ ...s, [item.id]: "Erreur réseau" }));
    } finally {
      setBusy((s) => ({ ...s, [item.id]: false }));
    }
  }

  async function cancel(item: Item) {
    setBusy((s) => ({ ...s, [item.id]: true }));
    try {
      const res = await fetch("/api/content-batches/approve", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queueId: item.id, contentType: item.contentType }),
      });
      const json = await res.json();
      if (!res.ok) { setMsg((s) => ({ ...s, [item.id]: json.error || `Erreur ${res.status}` })); return; }
      load(tab);
    } finally {
      setBusy((s) => ({ ...s, [item.id]: false }));
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-semibold text-white mb-1">Contenus vidéo — nouveaux formats</h1>
      <p className="text-sm text-gray-400 mb-6">
        Demand-Gen élargi, Avant-Après et Assembly — tout reste en brouillon tant que ce n&apos;est pas approuvé ici.
      </p>

      <div className="flex gap-2 mb-5 border-b border-gray-800">
        {TABS.map((t) => (
          <button
            key={t.type}
            onClick={() => setTab(t.type)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.type ? "border-blue-500 text-white" : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && <p className="text-gray-400">Chargement…</p>}
      {error && <p className="text-red-400">{error}</p>}

      {!loading && !error && items.length === 0 && (
        <p className="text-gray-500 text-sm">Aucun élément pour ce format.</p>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-left">
              <tr>
                <th className="px-4 py-2">SKU</th>
                <th className="px-4 py-2">Produit</th>
                <th className="px-4 py-2">Aperçu</th>
                <th className="px-4 py-2">Statut</th>
                <th className="px-4 py-2">Créneau</th>
                <th className="px-4 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const meta = STATUS_META[item.status] ?? { label: item.status, cls: "bg-gray-800 text-gray-300 border-gray-700" };
                const canApprove = item.status === "draft" || item.status === "pending";
                return (
                  <tr key={item.id} className="border-t border-gray-800">
                    <td className="px-4 py-3 font-mono text-gray-300">{item.sku}</td>
                    <td className="px-4 py-3 text-gray-300 max-w-xs truncate">{item.payload.productName ?? "—"}</td>
                    <td className="px-4 py-3">
                      {item.payload.blobUrl ? (
                        <a href={item.payload.blobUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">
                          ▶ Voir la vidéo
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${meta.cls}`}>{meta.label}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-400 whitespace-nowrap">
                      {item.status === "published" && item.publishedAt ? formatSlot(item.publishedAt) : formatSlot(item.scheduledAt)}
                    </td>
                    <td className="px-4 py-3">
                      {canApprove ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="datetime-local"
                            min={earliestSlotValue()}
                            value={picker[item.id] ?? earliestSlotValue()}
                            onChange={(e) => setPicker((s) => ({ ...s, [item.id]: e.target.value }))}
                            className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
                          />
                          <button
                            disabled={busy[item.id]}
                            onClick={() => approve(item, picker[item.id])}
                            className="text-xs px-2 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50"
                          >
                            {item.status === "draft" ? "Approuver" : "Replanifier"}
                          </button>
                          <button
                            disabled={busy[item.id]}
                            onClick={() => cancel(item)}
                            className="text-xs px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-50"
                          >
                            Annuler
                          </button>
                        </div>
                      ) : (
                        <span className="text-gray-600 text-xs">—</span>
                      )}
                      {msg[item.id] && <p className="text-xs text-gray-400 mt-1">{msg[item.id]}</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
