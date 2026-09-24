"use client";

import { useState, useEffect, useCallback } from "react";

// ─── Types (mirror /api/guides GuidePageRow) ─────────────────────────

interface GuideRow {
  id: number;
  aosom_category: string;
  shopify_collection_id: string;
  shopify_collection_title: string;
  status: "pending_review" | "skipped_empty" | "published";
  skip_reason: string | null;
  shopify_article_id: string | null;
  shopify_blog_id: number | null;
  shopify_handle: string | null;
  title: string | null;
  min_price: number | null;
  max_price: number | null;
  in_stock_count: number | null;
  body_html: string | null;
  fact_check_score: number | null;
  fact_check_issues: string | null;
  quality_score: number | null;
  quality_reasons: string | null;
  overall_status: "ready" | "attention" | null;
  quality_score_before_retry: number | null;
  fact_check_score_before_retry: number | null;
  /** SQLite datetime TEXT ('YYYY-MM-DD HH:MM:SS' UTC), set once approved — the guide stays
   * pending_review, queued for the hourly publisher, until this slot is actually drained. */
  scheduled_publish_at: string | null;
  created_at: number;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending_review: { label: "📝 À réviser", cls: "bg-amber-900/40 text-amber-300 border-amber-800/50" },
  published: { label: "✅ Publié", cls: "bg-green-900/40 text-green-300 border-green-800/50" },
  skipped_empty: { label: "⏭️ Ignoré (données insuffisantes)", cls: "bg-gray-800 text-gray-500 border-gray-700" },
};

function money(n: number | null): string {
  if (n === null) return "—";
  return n.toFixed(2).replace(".", ",") + " $";
}

function formatDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString("fr-CA", { dateStyle: "medium", timeStyle: "short" });
}

/** SQLite datetime TEXT ('YYYY-MM-DD HH:MM:SS' UTC) → unix seconds. */
function sqliteUtcToUnixSec(s: string): number {
  return Math.floor(Date.parse(`${s.replace(" ", "T")}Z`) / 1000);
}

function formatSqliteUtc(s: string): string {
  return formatDate(sqliteUtcToUnixSec(s));
}

/** unix seconds → value for <input type="datetime-local"> (local wall-clock, no timezone). */
function toDatetimeLocalValue(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function VerdictBadge({ label, score }: { label: string; score: number | null }) {
  if (score === null) {
    return <span className="text-xs text-gray-500">{label} : non disponible</span>;
  }
  const cls =
    score >= 80
      ? "bg-green-900/40 text-green-300 border-green-800/50"
      : score >= 60
        ? "bg-amber-900/40 text-amber-300 border-amber-800/50"
        : "bg-red-950/40 text-red-300 border-red-800/50";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${cls}`}>
      {label} : {score}/100
    </span>
  );
}

export default function GuidesClient() {
  const [guides, setGuides] = useState<GuideRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("pending_review");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/guides");
      const d = await res.json();
      if (res.ok && Array.isArray(d.guides)) {
        setGuides(d.guides);
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

  const approve = useCallback(
    async (id: number) => {
      if (!confirm("Approuver ce guide ? Il sera planifié pour publication automatique au prochain créneau libre (pas publié à l'instant).")) return;
      setActingId(id);
      setError(null);
      try {
        const res = await fetch(`/api/guides/${id}/approve`, { method: "POST" });
        const d = await res.json();
        if (!res.ok) setError(d.error || "Planification échouée.");
        await load();
      } catch (err) {
        setError(String(err));
      } finally {
        setActingId(null);
      }
    },
    [load],
  );

  const reschedule = useCallback(
    async (id: number, unixSec: number) => {
      setActingId(id);
      setError(null);
      try {
        const res = await fetch(`/api/guides/${id}/schedule`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scheduled_at: unixSec }),
        });
        const d = await res.json();
        if (!res.ok) setError(d.error || "Changement de date échoué.");
        await load();
      } catch (err) {
        setError(String(err));
      } finally {
        setActingId(null);
      }
    },
    [load],
  );

  const cancelSchedule = useCallback(
    async (id: number) => {
      if (!confirm("Annuler la planification de ce guide ? Il redeviendra en attente d'approbation.")) return;
      setActingId(id);
      setError(null);
      try {
        const res = await fetch(`/api/guides/${id}/schedule`, { method: "DELETE" });
        const d = await res.json();
        if (!res.ok) setError(d.error || "Annulation échouée.");
        await load();
      } catch (err) {
        setError(String(err));
      } finally {
        setActingId(null);
      }
    },
    [load],
  );

  const visible = guides.filter((g) => statusFilter === "all" || g.status === statusFilter);
  const pendingCount = guides.filter((g) => g.status === "pending_review").length;
  const attentionCount = guides.filter((g) => g.status === "pending_review" && g.overall_status === "attention").length;

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-white">Guides d&apos;achat (pSEO)</h2>
          <p className="text-gray-400 text-sm mt-0.5">
            Guides de sous-catégorie générés depuis le trend score réel. Relis le texte complet
            ici, puis approuve pour planifier une publication réelle sur Shopify à un créneau à
            venir (1-2 guides/semaine, espacés) — rien ne publie à l&apos;instant du clic, et
            rien ne publie sans cette approbation.
          </p>
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="pending_review">À réviser</option>
          <option value="published">Publiés</option>
          <option value="skipped_empty">Ignorés</option>
          <option value="all">Tous</option>
        </select>
      </div>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      <h3 className="text-sm font-semibold text-gray-300 mb-3">
        {pendingCount > 0 ? `${pendingCount} guide${pendingCount > 1 ? "s" : ""} en attente` : "Guides d'achat"}
        {attentionCount > 0 && (
          <span className="text-amber-400 font-normal"> · {attentionCount} à surveiller (score qualité sous 80)</span>
        )}
        <span className="text-gray-500 font-normal"> · {visible.length} affiché{visible.length > 1 ? "s" : ""}</span>
      </h3>

      {loading ? (
        <p className="text-gray-500 text-sm">Chargement…</p>
      ) : visible.length === 0 ? (
        <div className="p-10 text-center text-gray-500 text-sm border border-dashed border-gray-800 rounded-xl">
          Aucun guide dans ce filtre. Génère un lot pilote via&nbsp;:
          <code className="block mt-2 text-[11px] text-amber-200/90">
            node-x64 --env-file=.env.local tsx src/scripts/run-guide-pilot.ts 5
          </code>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {visible.map((g) => (
            <GuideCard
              key={g.id}
              guide={g}
              acting={actingId}
              expanded={expandedId === g.id}
              onToggleExpand={() => setExpandedId(expandedId === g.id ? null : g.id)}
              onApprove={approve}
              onReschedule={reschedule}
              onCancelSchedule={cancelSchedule}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function GuideCard({
  guide,
  acting,
  expanded,
  onToggleExpand,
  onApprove,
  onReschedule,
  onCancelSchedule,
}: {
  guide: GuideRow;
  acting: number | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onApprove: (id: number) => void;
  onReschedule: (id: number, unixSec: number) => void;
  onCancelSchedule: (id: number) => void;
}) {
  const meta = STATUS_META[guide.status] ?? { label: guide.status, cls: "bg-gray-800 text-gray-400 border-gray-700" };
  const busy = acting === guide.id;
  const liveUrl = guide.shopify_handle ? `https://ameublodirect.ca/blogs/guides/${guide.shopify_handle}` : null;
  const adminUrl =
    guide.shopify_article_id ? `https://admin.shopify.com/store/27u5y2-kp/articles/${guide.shopify_article_id}` : null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${meta.cls}`}>
              {meta.label}
            </span>
            <h4 className="text-white font-semibold mt-1">{guide.title || guide.shopify_collection_title}</h4>
            <p className="text-xs text-gray-500">{guide.aosom_category}</p>
          </div>
          <div className="text-right text-xs text-gray-400">
            <div>{formatDate(guide.created_at)}</div>
            {guide.min_price !== null && (
              <div>{money(guide.min_price)} – {money(guide.max_price)} · {guide.in_stock_count} en stock</div>
            )}
          </div>
        </div>

        {guide.status === "skipped_empty" && guide.skip_reason && (
          <p className="text-xs text-gray-500 italic">Raison : {guide.skip_reason}</p>
        )}

        {(guide.fact_check_score !== null || guide.quality_score !== null) && (
          <div className="flex flex-wrap gap-2">
            <VerdictBadge label="Cohérence factuelle" score={guide.fact_check_score} />
            <VerdictBadge label="Ton / structure / marque" score={guide.quality_score} />
            {guide.overall_status === "attention" && (
              <span className="text-xs text-amber-400">⚠️ à relire attentivement avant publication</span>
            )}
          </div>
        )}
        {guide.quality_score_before_retry !== null && (
          <p className="text-xs text-blue-300">
            🔄 Retenté automatiquement — qualité {guide.quality_score_before_retry} → {guide.quality_score}
            {guide.fact_check_score_before_retry !== null && guide.fact_check_score_before_retry !== guide.fact_check_score
              ? `, cohérence ${guide.fact_check_score_before_retry} → ${guide.fact_check_score}`
              : ""}
            {(guide.quality_score ?? 0) <= guide.quality_score_before_retry
              ? " — aucune amélioration, la 1re version aurait été aussi bonne"
              : " — amélioration"}
          </p>
        )}
        {(guide.fact_check_issues || guide.quality_reasons) && (
          <div className="text-xs text-gray-500 space-y-0.5">
            {guide.fact_check_issues && <p>• Cohérence : {guide.fact_check_issues}</p>}
            {guide.quality_reasons && <p>• Ton/structure : {guide.quality_reasons}</p>}
          </div>
        )}

        {guide.status === "pending_review" && guide.scheduled_publish_at && (
          <ScheduleBanner
            guideId={guide.id}
            scheduledAt={guide.scheduled_publish_at}
            busy={busy}
            onReschedule={onReschedule}
            onCancelSchedule={onCancelSchedule}
          />
        )}

        <div className="flex flex-wrap gap-2">
          {guide.body_html && (
            <button
              onClick={onToggleExpand}
              className="px-2.5 py-1 text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 rounded-md transition-colors"
            >
              {expanded ? "▲ Masquer le texte" : "▼ Lire le texte complet"}
            </button>
          )}
          {adminUrl && (
            <a
              href={adminUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2.5 py-1 text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 rounded-md transition-colors"
            >
              Ouvrir dans Shopify Admin
            </a>
          )}
          {liveUrl && guide.status === "published" && (
            <a
              href={liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2.5 py-1 text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 rounded-md transition-colors"
            >
              Voir la page en ligne
            </a>
          )}
          {guide.status === "pending_review" && !guide.scheduled_publish_at && (
            <button
              onClick={() => onApprove(guide.id)}
              disabled={busy}
              className="px-2.5 py-1 text-xs font-medium bg-green-900/40 hover:bg-green-900/60 text-green-400 border border-green-800/50 rounded-md transition-colors disabled:opacity-50"
            >
              {busy ? "Planification…" : "📅 Approuver et planifier"}
            </button>
          )}
        </div>

        {expanded && guide.body_html && (
          <div
            className="mt-2 p-4 bg-white text-gray-900 rounded-lg text-sm prose prose-sm max-w-none overflow-x-auto [&_script]:hidden"
            dangerouslySetInnerHTML={{ __html: guide.body_html }}
          />
        )}
      </div>
    </div>
  );
}

function ScheduleBanner({
  guideId,
  scheduledAt,
  busy,
  onReschedule,
  onCancelSchedule,
}: {
  guideId: number;
  scheduledAt: string;
  busy: boolean;
  onReschedule: (id: number, unixSec: number) => void;
  onCancelSchedule: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(() => toDatetimeLocalValue(sqliteUtcToUnixSec(scheduledAt)));

  const save = () => {
    const unixSec = Math.floor(new Date(value).getTime() / 1000);
    if (!Number.isFinite(unixSec)) return;
    onReschedule(guideId, unixSec);
    setEditing(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs bg-blue-950/40 border border-blue-900/50 rounded-md px-3 py-2">
      <span className="text-blue-300">
        📅 Planifié pour le <strong>{formatSqliteUtc(scheduledAt)}</strong> — publication
        automatique par le prochain passage du cron (aucune action manuelle requise).
      </span>
      {editing ? (
        <span className="flex items-center gap-1.5">
          <input
            type="datetime-local"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="px-1.5 py-0.5 bg-gray-900 border border-gray-700 rounded text-gray-200"
          />
          <button
            onClick={save}
            disabled={busy}
            className="px-2 py-0.5 bg-blue-900/50 hover:bg-blue-900/70 text-blue-300 border border-blue-800/50 rounded transition-colors disabled:opacity-50"
          >
            Enregistrer
          </button>
          <button
            onClick={() => setEditing(false)}
            className="px-2 py-0.5 text-gray-400 hover:text-gray-200"
          >
            Annuler
          </button>
        </span>
      ) : (
        <span className="flex items-center gap-1.5">
          <button
            onClick={() => setEditing(true)}
            disabled={busy}
            className="px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 rounded transition-colors disabled:opacity-50"
          >
            Modifier la date
          </button>
          <button
            onClick={() => onCancelSchedule(guideId)}
            disabled={busy}
            className="px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-red-400 border border-gray-700 rounded transition-colors disabled:opacity-50"
          >
            Annuler la planification
          </button>
        </span>
      )}
    </div>
  );
}
