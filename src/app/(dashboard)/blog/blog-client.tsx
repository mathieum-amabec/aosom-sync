"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { BLOG_DRAFTS_CHANGED } from "@/components/sidebar";

// ─── Types (mirror GET /api/blog/queue) ─────────────────────────────────────

type BlogStatus = "draft" | "approved" | "published" | "failed";
type BlogLang = "fr" | "en";

interface BlogPost {
  id: number;
  title: string;
  lang: BlogLang;
  status: BlogStatus;
  shopify_article_id: string | null;
  approved_at: number | null;
  published_at: number | null;
  created_at: number;
  /** Shopify admin deep link, or null for a 'failed' row with no article. */
  adminUrl: string | null;
}

type StatusCounts = Record<BlogStatus, number>;

const STATUS_META: Record<BlogStatus, { label: string; cls: string }> = {
  draft: { label: "📝 Brouillon", cls: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30" },
  approved: { label: "👍 Approuvé", cls: "bg-blue-500/10 text-blue-400 border-blue-500/30" },
  published: { label: "✅ Publié", cls: "bg-green-500/10 text-green-400 border-green-500/30" },
  failed: { label: "❌ Échec", cls: "bg-red-500/10 text-red-400 border-red-500/30" },
};

const STATUS_ORDER: BlogStatus[] = ["draft", "approved", "published", "failed"];

const EMPTY_COUNTS: StatusCounts = { draft: 0, approved: 0, published: 0, failed: 0 };

function formatDate(unixSec: number | null): string {
  if (!unixSec) return "—";
  return new Date(unixSec * 1000).toLocaleString("fr-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function BlogClient() {
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [counts, setCounts] = useState<StatusCounts>(EMPTY_COUNTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<number | null>(null);
  const [langFilter, setLangFilter] = useState<"all" | BlogLang>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | BlogStatus>("all");

  // Filtering runs server-side so the list always reflects the whole table, not just the
  // rows already fetched.
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (langFilter !== "all") p.set("lang", langFilter);
    if (statusFilter !== "all") p.set("status", statusFilter);
    const s = p.toString();
    return s ? `?${s}` : "";
  }, [langFilter, statusFilter]);

  // Flipping filters quickly fires overlapping requests; without this guard a slow earlier
  // response can land last and repaint the table with the previous filter's rows.
  const reqSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    try {
      const res = await fetch(`/api/blog/queue${query}`);
      const d = await res.json();
      if (seq !== reqSeq.current) return; // superseded by a newer request
      if (res.ok && d.success) {
        setPosts(d.data.posts);
        setCounts(d.data.counts ?? EMPTY_COUNTS);
        setError(null);
      } else {
        setError(d.error || "Échec du chargement.");
      }
    } catch (err) {
      if (seq === reqSeq.current) setError(String(err));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  const act = useCallback(
    async (post: BlogPost, action: "approve" | "publish" | "delete") => {
      if (
        action === "delete" &&
        !window.confirm(
          `Supprimer « ${post.title} » de la liste ?\n\n` +
            "L'article Shopify n'est PAS supprimé — seule la ligne du tableau de bord disparaît.",
        )
      ) {
        return;
      }
      setActingId(post.id);
      setError(null);
      try {
        const res = await fetch(
          action === "delete" ? `/api/blog/${post.id}` : `/api/blog/${action}`,
          action === "delete"
            ? { method: "DELETE" }
            : {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: post.id }),
              },
        );
        const d = await res.json().catch(() => ({}));
        if (!res.ok) setError(d.error || "Action échouée.");
        await load();
        // Nudge the sidebar badge instead of letting it drift until its next 30s poll —
        // approving the last draft should empty the pill right away.
        window.dispatchEvent(new Event(BLOG_DRAFTS_CHANGED));
      } catch (err) {
        setError(String(err));
      } finally {
        setActingId(null);
      }
    },
    [load],
  );

  return (
    <div className="p-4 md:p-8 max-w-6xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-white">Blog</h2>
        <p className="text-sm text-gray-500 mt-1">
          Articles générés automatiquement (lundi + jeudi, 08:00 UTC). Ils partent en brouillon
          dans Shopify&nbsp;: approuve-les puis publie-les ici, ou laisse la porte
          d&apos;auto-publication (qualité + saison + quota hebdo) les mettre en ligne.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {STATUS_ORDER.map((s) => (
          <div key={s} className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
            <p className="text-xs text-gray-500">{STATUS_META[s].label}</p>
            <p className="text-xl font-semibold text-white mt-0.5">{counts[s]}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          aria-label="Filtrer par langue"
          value={langFilter}
          onChange={(e) => setLangFilter(e.target.value as "all" | BlogLang)}
          className="px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="all">Toutes les langues</option>
          <option value="fr">Français</option>
          <option value="en">Anglais</option>
        </select>
        <select
          aria-label="Filtrer par statut"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "all" | BlogStatus)}
          className="px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="all">Tous les statuts</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_META[s].label}
            </option>
          ))}
        </select>
        <span className="text-xs text-gray-500">
          {posts.length} article{posts.length > 1 ? "s" : ""} affiché
          {posts.length > 1 ? "s" : ""}
        </span>
      </div>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      {loading ? (
        <p className="text-gray-500 text-sm">Chargement…</p>
      ) : posts.length === 0 ? (
        <div className="p-8 bg-gray-900 border border-gray-800 rounded-xl text-center">
          <p className="text-gray-500 text-sm">Aucun article pour ce filtre</p>
          <p className="text-gray-600 text-xs mt-1">
            Le prochain passage du cron remplira cette liste.
          </p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400">
                <th className="text-left px-4 py-3 font-medium">Titre</th>
                <th className="text-left px-4 py-3 font-medium">Langue</th>
                <th className="text-left px-4 py-3 font-medium">Statut</th>
                <th className="text-left px-4 py-3 font-medium">Créé</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((post) => (
                <tr key={post.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-4 py-3 text-gray-200">
                    {post.title}
                    {post.status === "published" && post.published_at && (
                      <span className="block text-[11px] text-green-400/80 mt-0.5">
                        En ligne depuis le {formatDate(post.published_at)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400 uppercase">{post.lang}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block px-2 py-0.5 text-xs font-medium rounded-md border ${STATUS_META[post.status].cls}`}
                    >
                      {STATUS_META[post.status].label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400 whitespace-nowrap">
                    {formatDate(post.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    <RowActions post={post} busy={actingId === post.id} onAct={act} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RowActions({
  post,
  busy,
  onAct,
}: {
  post: BlogPost;
  busy: boolean;
  onAct: (post: BlogPost, action: "approve" | "publish" | "delete") => void;
}) {
  const btn =
    "px-2.5 py-1 text-xs font-medium rounded-md border transition-colors disabled:opacity-50";

  return (
    <div className="flex flex-wrap gap-2 justify-end">
      {post.adminUrl && (
        <a
          href={post.adminUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`${btn} bg-gray-800 hover:bg-gray-700 text-gray-300 border-gray-700`}
        >
          Aperçu
        </a>
      )}
      {post.status === "draft" && (
        <button
          onClick={() => onAct(post, "approve")}
          disabled={busy}
          className={`${btn} bg-blue-900/40 hover:bg-blue-900/60 text-blue-300 border-blue-800/50`}
        >
          {busy ? "…" : "Approuver"}
        </button>
      )}
      {post.status === "approved" && (
        <button
          onClick={() => onAct(post, "publish")}
          disabled={busy}
          className={`${btn} bg-green-900/40 hover:bg-green-900/60 text-green-400 border-green-800/50`}
        >
          {busy ? "…" : "Publier"}
        </button>
      )}
      <button
        onClick={() => onAct(post, "delete")}
        disabled={busy}
        className={`${btn} bg-red-950/40 hover:bg-red-950/60 text-red-400 border-red-800/50`}
      >
        {busy ? "…" : "Supprimer"}
      </button>
    </div>
  );
}
