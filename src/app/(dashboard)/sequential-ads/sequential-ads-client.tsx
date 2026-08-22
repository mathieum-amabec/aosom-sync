"use client";

import { useState, useEffect, useCallback } from "react";

// ─── Types (mirror /api/sequential-ads/queue SequentialAdQueueItem) ──────────

interface SequentialAdItem {
  id: number;
  content_id: string;
  status: string;
  scheduled_at: string;
  /** Actual publish time, or null. NOT interchangeable with scheduled_at — see below. */
  published_at: string | null;
  created_at: string;
  payload: { reelsVideoUrl?: string; caption?: string; brand?: string };
  style: string | null;
  campaign: string | null;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  draft: { label: "📝 Brouillon", cls: "bg-gray-800 text-gray-300 border-gray-700" },
  pending: { label: "⏳ Planifié", cls: "bg-blue-900/40 text-blue-300 border-blue-800/50" },
  publishing: { label: "📤 Publication…", cls: "bg-blue-900/40 text-blue-300 border-blue-800/50" },
  published: { label: "✅ Publié", cls: "bg-green-900/40 text-green-300 border-green-800/50" },
  failed: { label: "❌ Échec", cls: "bg-red-950/40 text-red-300 border-red-800/50" },
  cancelled: { label: "🚫 Annulé", cls: "bg-gray-800 text-gray-500 border-gray-700" },
};

const STYLE_LABEL: Record<string, string> = {
  hero_slides: "🖼️ Hero-slides",
  demand_gen_messages: "🎬 Demand-gen",
};

/** Format a SQLite UTC datetime ('YYYY-MM-DD HH:MM:SS') for display (fr-CA). */
function formatSlot(sqliteUtc: string): string {
  const d = new Date(`${sqliteUtc.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime())
    ? sqliteUtc
    : d.toLocaleString("fr-CA", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * SQLite UTC → the LOCAL 'YYYY-MM-DDTHH:MM' that <input type="datetime-local"> requires.
 * Built from the local getters rather than toISOString(), which would re-emit UTC and show
 * the operator a time four or five hours off their own clock.
 */
export function toLocalInputValue(sqliteUtc: string): string {
  const d = new Date(`${sqliteUtc.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function SequentialAdsClient() {
  const [items, setItems] = useState<SequentialAdItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<number | null>(null);
  const [campaignFilter, setCampaignFilter] = useState<string>("all");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sequential-ads/queue");
      const d = await res.json();
      if (res.ok && Array.isArray(d.items)) {
        setItems(d.items);
        setError(null);
      } else {
        setError(d.error || "Échec du chargement.");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** One request helper for every card action — always reloads so the UI shows server truth. */
  const post = useCallback(
    async (url: string, method: "POST" | "DELETE", id: number, body: Record<string, unknown>) => {
      setActingId(id);
      setError(null);
      try {
        const res = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) setError(d.error || "Action échouée.");
        await load();
      } catch (err) {
        setError(String(err));
      } finally {
        setActingId(null);
      }
    },
    [load],
  );

  const act = useCallback(
    (id: number, method: "POST" | "DELETE") =>
      post("/api/sequential-ads/approve", method, id, { queueId: id }),
    [post],
  );

  const publishNow = useCallback(
    (id: number) => post("/api/sequential-ads/publish-now", "POST", id, { queueId: id }),
    [post],
  );

  /** `local` is the raw <input type="datetime-local"> value; Date parses it as local time,
   *  and toISOString sends an unambiguous instant so the server never has to guess a zone. */
  const schedule = useCallback(
    (id: number, local: string) =>
      post("/api/sequential-ads/schedule", "POST", id, {
        queueId: id,
        scheduledAt: new Date(local).toISOString(),
      }),
    [post],
  );

  const campaigns = Array.from(
    new Set(items.map((it) => it.campaign).filter((c): c is string => !!c)),
  );
  const visible = items.filter(
    (it) => campaignFilter === "all" || it.campaign === campaignFilter,
  );
  const draftCount = visible.filter((it) => it.status === "draft").length;

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-white">Pubs séquentielles</h2>
          <p className="text-gray-400 text-sm mt-0.5">
            Vidéos à messages séquentiels (hero-slides &amp; demand-gen). Approuve un
            brouillon pour le planifier, choisis une date précise, ou publie tout de suite.
          </p>
        </div>
        {campaigns.length > 0 && (
          <select
            value={campaignFilter}
            onChange={(e) => setCampaignFilter(e.target.value)}
            className="px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="all">Toutes les campagnes</option>
            {campaigns.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
      </div>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      <h3 className="text-sm font-semibold text-gray-300 mb-3">
        {draftCount > 0
          ? `${draftCount} pub${draftCount > 1 ? "s" : ""} en attente d’approbation`
          : "Pubs séquentielles"}
        <span className="text-gray-500 font-normal"> · {visible.length} au total</span>
      </h3>

      {loading ? (
        <p className="text-gray-500 text-sm">Chargement…</p>
      ) : visible.length === 0 ? (
        <div className="p-10 text-center text-gray-500 text-sm border border-dashed border-gray-800 rounded-xl">
          Aucune pub séquentielle. Génère-en via le script&nbsp;:
          <code className="block mt-2 text-[11px] text-amber-200/90">
            tsx scripts/render-sequential-ads.mts --style hero --apply
          </code>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map((it) => (
            <SequentialAdCard
              key={it.id}
              item={it}
              acting={actingId}
              onAct={act}
              onPublishNow={publishNow}
              onSchedule={schedule}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SequentialAdCard({
  item,
  acting,
  onAct,
  onPublishNow,
  onSchedule,
}: {
  item: SequentialAdItem;
  acting: number | null;
  onAct: (id: number, method: "POST" | "DELETE") => void;
  onPublishNow: (id: number) => void;
  onSchedule: (id: number, local: string) => void;
}) {
  const meta = STATUS_META[item.status] ?? {
    label: item.status,
    cls: "bg-gray-800 text-gray-400 border-gray-700",
  };
  const url = item.payload.reelsVideoUrl;
  const title = item.payload.caption || item.content_id;
  const busy = acting === item.id;

  const [slot, setSlot] = useState(() => toLocalInputValue(item.scheduled_at));
  const [confirmingNow, setConfirmingNow] = useState(false);

  const isDraft = item.status === "draft";
  const isPending = item.status === "pending";
  const canSchedule = isDraft || isPending;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col">
      <div className="aspect-[9/16] bg-gray-950 flex items-center justify-center">
        {url?.startsWith("https://") ? (
          <video src={url} controls preload="metadata" className="w-full h-full object-contain" />
        ) : (
          <span className="text-xs text-gray-600">Aperçu indisponible</span>
        )}
      </div>
      <div className="p-3 flex-1 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${meta.cls}`}>
            {meta.label}
          </span>
          {item.style && (
            <span className="text-xs text-gray-400">{STYLE_LABEL[item.style] ?? item.style}</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {item.campaign && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-[#1A2340] text-[#D4A853] text-[10px] font-medium border border-[#D4A853]/30">
              {item.campaign}
            </span>
          )}
          {item.payload.brand && <span className="text-[10px] text-gray-500">{item.payload.brand}</span>}
        </div>
        <p className="text-xs text-gray-400 line-clamp-2" title={title}>{title}</p>
        {isPending && (
          <p className="text-xs text-blue-300">Planifié le {formatSlot(item.scheduled_at)}</p>
        )}
        {/* Read published_at, never scheduled_at. "Publier maintenant" posts immediately and
            leaves the planned slot alone, so a published ad routinely still carries a FUTURE
            scheduled_at — rendering that made a successful publish look like it had not
            happened yet. Falls back to the slot only for rows published before published_at
            was exposed by the API. */}
        {item.status === "published" && (
          <p className="text-xs text-green-300">
            ✅ Publié le {formatSlot(item.published_at ?? item.scheduled_at)}
            {item.published_at && item.published_at < item.scheduled_at && (
              <span className="text-gray-500"> · en avance sur le créneau</span>
            )}
          </p>
        )}

        {canSchedule && (
          <div className="mt-auto pt-1 flex flex-col gap-2">
            <div className="flex items-end gap-1.5">
              <label className="flex-1">
                <span className="block text-[10px] text-gray-500 mb-0.5">
                  {isDraft ? "Planifier pour" : "Replanifier"}
                </span>
                <input
                  type="datetime-local"
                  value={slot}
                  onChange={(e) => setSlot(e.target.value)}
                  disabled={busy}
                  aria-label={isDraft ? "Date de publication" : "Nouvelle date de publication"}
                  className="w-full px-2 py-1 bg-gray-950 border border-gray-700 rounded-md text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                />
              </label>
              <button
                onClick={() => onSchedule(item.id, slot)}
                disabled={busy || !slot}
                title={!slot ? "Choisis une date" : undefined}
                className="px-2.5 py-1 text-xs font-medium bg-blue-900/40 hover:bg-blue-900/60 text-blue-300 border border-blue-800/50 rounded-md transition-colors disabled:opacity-50"
              >
                {busy ? "…" : "📅 Planifier"}
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              {isDraft && (
                <button
                  onClick={() => onAct(item.id, "POST")}
                  disabled={busy}
                  className="px-2.5 py-1 text-xs font-medium bg-green-900/40 hover:bg-green-900/60 text-green-400 border border-green-800/50 rounded-md transition-colors disabled:opacity-50"
                >
                  {busy ? "…" : "✅ Approuver"}
                </button>
              )}

              {/* Publishing is irreversible — the post goes out to real followers — so the
                  button asks once before firing. Drafts never reach here: the API refuses
                  them, and requiring approval first keeps "publish now" from doubling as a
                  hidden approval. */}
              {isPending &&
                (confirmingNow ? (
                  <>
                    <button
                      onClick={() => {
                        setConfirmingNow(false);
                        onPublishNow(item.id);
                      }}
                      disabled={busy}
                      className="px-2.5 py-1 text-xs font-medium bg-amber-900/50 hover:bg-amber-900/70 text-amber-200 border border-amber-700/60 rounded-md transition-colors disabled:opacity-50"
                    >
                      {busy ? "…" : "Confirmer la publication"}
                    </button>
                    <button
                      onClick={() => setConfirmingNow(false)}
                      disabled={busy}
                      className="px-2.5 py-1 text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 rounded-md transition-colors disabled:opacity-50"
                    >
                      Annuler
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmingNow(true)}
                    disabled={busy}
                    className="px-2.5 py-1 text-xs font-medium bg-amber-900/40 hover:bg-amber-900/60 text-amber-300 border border-amber-800/50 rounded-md transition-colors disabled:opacity-50"
                  >
                    {busy ? "…" : "🚀 Publier maintenant"}
                  </button>
                ))}

              {isDraft && (
                <button
                  onClick={() => onAct(item.id, "DELETE")}
                  disabled={busy}
                  className="px-2.5 py-1 text-xs font-medium bg-red-950/40 hover:bg-red-950/60 text-red-400 border border-red-800/50 rounded-md transition-colors disabled:opacity-50"
                >
                  {busy ? "…" : "🗑️ Supprimer"}
                </button>
              )}

              {url?.startsWith("https://") && (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-2.5 py-1 text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 rounded-md transition-colors"
                >
                  Ouvrir
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
