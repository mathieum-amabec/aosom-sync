"use client";

import { useState, useEffect } from "react";

interface QueuedDraft {
  id: number;
  sku: string;
  postText: string;
  postTextEn: string | null;
  scheduledAt: number | null;
  status: string;
  productName?: string;
  productImage?: string;
  imageUrl: string | null;
}

function formatSlot(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString("fr-CA", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * "File de publication" — the upcoming queue of scheduled posts that the
 * /api/cron/social-scheduled cron will publish when each slot arrives.
 * Reads the existing `scheduled` drafts (no separate queue store).
 */
export function PublicationQueuePanel() {
  const [drafts, setDrafts] = useState<QueuedDraft[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/social?status=scheduled")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        if (!d?.success) { setError(true); return; }
        setDrafts((d.data as QueuedDraft[]) || []);
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <section className="mb-8">
        <h3 className="text-lg font-semibold text-white mb-3">File de publication</h3>
        <div className="p-6 bg-gray-900 border border-gray-800 rounded-xl flex items-center gap-3">
          <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-gray-400">Chargement…</span>
        </div>
      </section>
    );
  }

  const upcoming = (drafts ?? [])
    .filter((d) => d.scheduledAt != null)
    .sort((a, b) => (a.scheduledAt as number) - (b.scheduledAt as number))
    .slice(0, 8);

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-white">File de publication</h3>
        {drafts && drafts.length > 0 && (
          <span className="text-xs text-gray-500">{drafts.length} en file</span>
        )}
      </div>

      {error ? (
        <div className="p-4 bg-red-950/30 border border-red-800/50 rounded-xl text-sm text-red-300">
          Impossible de charger la file de publication.
        </div>
      ) : upcoming.length === 0 ? (
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl text-sm text-gray-500">
          Aucun post en file. Approuvez un brouillon dans Social Media pour le scheduler.
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <ul className="divide-y divide-gray-800/60">
            {upcoming.map((d) => {
              const thumb = d.productImage || d.imageUrl || null;
              const text = d.postText || d.postTextEn || "";
              return (
                <li key={d.id} className="flex items-center gap-3 px-4 py-2.5">
                  {thumb ? (
                    <img src={thumb} alt="" className="w-9 h-9 rounded-md object-cover bg-gray-800 shrink-0" />
                  ) : (
                    <div className="w-9 h-9 rounded-md bg-gray-800 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-300 truncate">{d.productName || d.sku}</p>
                    <p className="text-xs text-gray-500 truncate">{text}</p>
                  </div>
                  {d.scheduledAt != null && (
                    <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border bg-blue-900/40 text-blue-400 border-blue-800/50">
                      🕑 {formatSlot(d.scheduledAt)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
