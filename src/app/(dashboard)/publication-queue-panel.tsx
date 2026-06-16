"use client";

import { useState, useEffect } from "react";

type Platform = "facebook" | "instagram" | "both" | "shopify_blog";
type Status = "pending" | "publishing" | "published" | "failed" | "cancelled";

interface QueueItem {
  id: number;
  scheduledAt: number | null; // unix seconds (UTC)
  platform: Platform;
  contentType: "social" | "draft" | "blog";
  status: Status;
  preview: string;
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

const PLATFORM_LABEL: Record<Platform, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  both: "Facebook + Instagram",
  shopify_blog: "Blog",
};

function platformBadgeClass(p: Platform): string {
  switch (p) {
    case "facebook":
      return "bg-blue-900/40 text-blue-300 border-blue-800/50";
    case "instagram":
      return "bg-pink-900/40 text-pink-300 border-pink-800/50";
    case "both":
      return "bg-violet-900/40 text-violet-300 border-violet-800/50";
    case "shopify_blog":
      return "bg-emerald-900/40 text-emerald-300 border-emerald-800/50";
  }
}

const STATUS_LABEL: Record<Status, string> = {
  pending: "En attente",
  publishing: "Publication…",
  published: "Publié",
  failed: "Échec",
  cancelled: "Annulé",
};

function statusBadgeClass(s: Status): string {
  switch (s) {
    case "pending":
      return "bg-gray-800 text-gray-300 border-gray-700";
    case "publishing":
      return "bg-amber-900/40 text-amber-300 border-amber-800/50";
    case "published":
      return "bg-green-900/40 text-green-300 border-green-800/50";
    case "failed":
      return "bg-red-900/40 text-red-300 border-red-800/50";
    case "cancelled":
      return "bg-gray-800/60 text-gray-500 border-gray-700/60";
  }
}

/**
 * "File de publication" — upcoming posts the /api/cron/publisher cron will publish.
 * Reads the unified `publication_queue` (status='pending') via GET /api/queue.
 * (Previously read `/api/social?status=scheduled` / facebook_drafts, which the
 * Approve flow no longer feeds — see CLAUDE.md "Publication scheduling".)
 */
export function PublicationQueuePanel() {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/queue")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        if (!d?.success) { setError(true); return; }
        setItems((d.data as QueueItem[]) || []);
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

  const upcoming = (items ?? []).slice(0, 8);

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-white">File de publication</h3>
        {items && items.length > 0 && (
          <span className="text-xs text-gray-500">{items.length} en file</span>
        )}
      </div>

      {error ? (
        <div className="p-4 bg-red-950/30 border border-red-800/50 rounded-xl text-sm text-red-300">
          Impossible de charger la file de publication.
        </div>
      ) : upcoming.length === 0 ? (
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl text-sm text-gray-500">
          Aucun post en file. Approuvez un brouillon dans Social Media pour le mettre en file.
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <ul className="divide-y divide-gray-800/60">
            {upcoming.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                {item.imageUrl ? (
                  <img src={item.imageUrl} alt="" className="w-9 h-9 rounded-md object-cover bg-gray-800 shrink-0" />
                ) : (
                  <div className="w-9 h-9 rounded-md bg-gray-800 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${platformBadgeClass(item.platform)}`}>
                      {PLATFORM_LABEL[item.platform]}
                    </span>
                    <span className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${statusBadgeClass(item.status)}`}>
                      {STATUS_LABEL[item.status]}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 truncate mt-1">{item.preview || "(aucun aperçu)"}</p>
                </div>
                <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border bg-blue-900/40 text-blue-400 border-blue-800/50">
                  🕑 {item.scheduledAt != null ? formatSlot(item.scheduledAt) : "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
