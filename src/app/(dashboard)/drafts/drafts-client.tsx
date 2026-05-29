"use client";

import { useState, useEffect, useCallback } from "react";
import type { FacebookDraft, DraftsPage } from "@/lib/database";
import { approveDraft, rejectDraft, publishDraft } from "./actions";
import type { PublishLanguage } from "./actions";

const STATUS_LABELS: Record<string, string> = {
  draft: "En attente",
  approved: "Approuvé",
  rejected: "Rejeté",
  published: "Publié",
  scheduled: "Planifié",
  publishing: "En cours…",
  failed: "Échec",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-red-100 text-red-800",
  published: "bg-gray-100 text-gray-700",
  scheduled: "bg-purple-100 text-purple-800",
  publishing: "bg-blue-100 text-blue-800",
  failed: "bg-orange-100 text-orange-800",
};

const TRIGGER_LABELS: Record<string, string> = {
  stock_highlight: "Produit",
  content_template: "Contenu",
  new_product: "Nouveau produit",
};

const TRIGGER_COLORS: Record<string, string> = {
  stock_highlight: "bg-green-100 text-green-800",
  content_template: "bg-blue-100 text-blue-800",
  new_product: "bg-purple-100 text-purple-800",
};

function formatDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString("fr-CA", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/** Local-tz "YYYY-MM-DDTHH:mm" suitable for <input type="datetime-local"> defaults. */
function toLocalInputValue(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function DraftsClient() {
  const [data, setData] = useState<DraftsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<FacebookDraft | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectNotes, setRejectNotes] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingLanguage, setPendingLanguage] = useState<PublishLanguage | null>(null);
  const [publishFeedback, setPublishFeedback] = useState<{ type: "success" | "partial" | "error"; message: string } | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState("draft");
  const [triggerFilter, setTriggerFilter] = useState("");
  const [hookFilter, setHookFilter] = useState("all");
  const [page, setPage] = useState(1);

  // Schedule UI state
  const [scheduledAt, setScheduledAt] = useState("");

  const fetchDrafts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (statusFilter) params.set("status", statusFilter);
      if (triggerFilter) params.set("triggerType", triggerFilter);
      if (hookFilter !== "all") params.set("hook", hookFilter);
      const res = await fetch(`/api/drafts?${params}`);
      if (!res.ok) throw new Error("Échec de chargement");
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur inconnue");
    }
    setLoading(false);
  }, [statusFilter, triggerFilter, hookFilter, page]);

  useEffect(() => { fetchDrafts(); }, [fetchDrafts]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [statusFilter, triggerFilter, hookFilter]);

  // Deselect if selected draft is no longer in current list
  useEffect(() => {
    if (selected && data) {
      const still = data.items.find((d) => d.id === selected.id);
      if (!still) { setSelected(null); setPendingLanguage(null); }
    }
  }, [data, selected]);

  async function handleApprove() {
    if (!selected) return;
    setActionLoading(true);
    const result = await approveDraft(selected.id);
    if (result.error) setError(result.error);
    else { setSelected(null); fetchDrafts(); }
    setActionLoading(false);
  }

  async function handleReject() {
    if (!selected || !rejectNotes.trim()) return;
    setActionLoading(true);
    const result = await rejectDraft(selected.id, rejectNotes.trim());
    if (result.error) setError(result.error);
    else { setSelected(null); setRejectNotes(""); setShowRejectInput(false); fetchDrafts(); }
    setActionLoading(false);
  }

  async function handleSchedule() {
    if (!selected || !scheduledAt) return;
    const dt = new Date(scheduledAt);
    if (isNaN(dt.getTime())) { setError("Date invalide"); return; }
    const unixTs = Math.floor(dt.getTime() / 1000);
    if (unixTs <= Math.floor(Date.now() / 1000)) {
      setError("La date de publication doit être dans le futur"); return;
    }
    setError(null);
    setActionLoading(true);
    try {
      const res = await fetch(`/api/social/drafts/${selected.id}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduled_at: unixTs }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Échec planification (${res.status})`);
      } else {
        setScheduledAt("");
        setSelected(null);
        fetchDrafts();
      }
    } finally {
      setActionLoading(false);
    }
  }

  async function handleCancelSchedule() {
    if (!selected) return;
    setError(null);
    setActionLoading(true);
    try {
      const res = await fetch(`/api/social/drafts/${selected.id}/schedule`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Échec annulation (${res.status})`);
      } else {
        setSelected(null);
        fetchDrafts();
      }
    } finally {
      setActionLoading(false);
    }
  }

  async function handlePublish() {
    if (!selected || !pendingLanguage) return;
    setActionLoading(true);
    const lang = pendingLanguage;
    setPendingLanguage(null);
    setPublishFeedback(null);
    const result = await publishDraft(selected.id, lang);
    if (result.success) {
      const to = result.publishedTo.join(", ");
      const msg = result.partialFailures
        ? `Publié sur ${to}. Partiel: ${result.partialFailures.map((f) => `${f.brand}: ${f.error}`).join("; ")}`
        : `Publié sur ${to} (${result.fbPostIds.join(", ")})`;
      setPublishFeedback({ type: result.partialFailures ? "partial" : "success", message: msg });
      fetchDrafts();
    } else {
      setPublishFeedback({ type: "error", message: result.error });
    }
    setActionLoading(false);
  }

  const statusCount = (s: string) => data?.items.filter((d) => d.status === s).length ?? 0;

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Drafts Review</h1>
          {data && (
            <p className="text-sm text-gray-500 mt-0.5">
              {data.total} draft{data.total !== 1 ? "s" : ""}
              {statusFilter === "draft" ? " en attente" : ""}
            </p>
          )}
        </div>
        {error && (
          <div className="text-sm text-red-600 bg-red-50 px-3 py-1 rounded">
            {error}
            <button className="ml-2 underline" onClick={() => setError(null)}>✕</button>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="bg-white border-b px-6 py-3 flex flex-wrap gap-3 items-center">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Tous les statuts</option>
          <option value="draft">En attente</option>
          <option value="approved">Approuvé</option>
          <option value="scheduled">Planifié</option>
          <option value="rejected">Rejeté</option>
          <option value="published">Publié</option>
          <option value="failed">Échec</option>
        </select>

        <select
          value={triggerFilter}
          onChange={(e) => setTriggerFilter(e.target.value)}
          className="text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Tous les types</option>
          <option value="content_template">Contenu</option>
          <option value="stock_highlight">Produit</option>
          <option value="new_product">Nouveau produit</option>
        </select>

        <select
          value={hookFilter}
          onChange={(e) => setHookFilter(e.target.value)}
          className="text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">Tous les hooks</option>
          <option value="with">Avec hook</option>
          <option value="without">Sans hook</option>
        </select>

        <button
          onClick={fetchDrafts}
          className="ml-auto text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
          </svg>
          Actualiser
        </button>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Draft list */}
        <div className="w-80 flex-shrink-0 border-r bg-white overflow-y-auto">
          {loading && (
            <div className="p-6 text-center text-sm text-gray-400">Chargement…</div>
          )}
          {!loading && data?.items.length === 0 && (
            <div className="p-6 text-center text-sm text-gray-400">Aucun draft trouvé</div>
          )}
          {!loading && data?.items.map((draft) => (
            <button
              key={draft.id}
              onClick={() => { setSelected(draft); setShowRejectInput(false); setRejectNotes(""); setPendingLanguage(null); setScheduledAt(""); }}
              className={`w-full text-left px-4 py-3 border-b hover:bg-gray-50 transition-colors ${selected?.id === draft.id ? "bg-blue-50 border-l-2 border-l-blue-500" : ""}`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[draft.status] ?? "bg-gray-100 text-gray-700"}`}>
                  {STATUS_LABELS[draft.status] ?? draft.status}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TRIGGER_COLORS[draft.triggerType] ?? "bg-gray-100 text-gray-700"}`}>
                  {TRIGGER_LABELS[draft.triggerType] ?? draft.triggerType}
                  {draft.hookId != null && <span className="ml-1 opacity-70">◆</span>}
                </span>
              </div>
              <p className="text-sm text-gray-700 line-clamp-2 leading-snug">
                {(draft.postText || draft.postTextEn || "").slice(0, 100)}
              </p>
              <p className="text-xs text-gray-400 mt-1">{formatDate(draft.createdAt)}</p>
            </button>
          ))}

          {/* Pagination */}
          {data && data.total > data.pageSize && (
            <div className="p-3 flex justify-between items-center border-t">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="text-xs text-blue-600 disabled:text-gray-300"
              >← Préc.</button>
              <span className="text-xs text-gray-500">Page {page}</span>
              <button
                disabled={!data.hasMore}
                onClick={() => setPage((p) => p + 1)}
                className="text-xs text-blue-600 disabled:text-gray-300"
              >Suiv. →</button>
            </div>
          )}
        </div>

        {/* Right: Preview */}
        <div className="flex-1 overflow-y-auto p-6">
          {!selected ? (
            <div className="h-full flex items-center justify-center text-sm text-gray-400">
              Sélectionnez un draft pour le prévisualiser
            </div>
          ) : (
            <div className="max-w-2xl mx-auto space-y-6">
              {/* Meta */}
              <div className="flex items-center gap-3 flex-wrap">
                <span className={`text-sm px-3 py-1 rounded-full font-medium ${STATUS_COLORS[selected.status] ?? "bg-gray-100 text-gray-700"}`}>
                  {STATUS_LABELS[selected.status] ?? selected.status}
                </span>
                <span className={`text-sm px-3 py-1 rounded-full font-medium ${TRIGGER_COLORS[selected.triggerType] ?? "bg-gray-100 text-gray-700"}`}>
                  {TRIGGER_LABELS[selected.triggerType] ?? selected.triggerType}
                </span>
                <span className="text-sm text-gray-400">{formatDate(selected.createdAt)}</span>
                {selected.hookId != null && (
                  <span className="text-sm text-purple-600">◆ Hook #{selected.hookId}</span>
                )}
              </div>

              {/* Unsplash image + attribution (content_template drafts) */}
              {selected.unsplashImageUrl && (
                <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={selected.unsplashImageUrl}
                    alt="Illustration Unsplash du post"
                    className="w-full h-56 object-cover"
                  />
                  {selected.unsplashPhotographer && (
                    <p className="px-4 py-2 text-xs text-gray-400">
                      Photo par{" "}
                      {selected.unsplashPhotographerUrl ? (
                        <a
                          href={selected.unsplashPhotographerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline hover:text-gray-600"
                        >
                          {selected.unsplashPhotographer}
                        </a>
                      ) : (
                        selected.unsplashPhotographer
                      )}{" "}
                      sur Unsplash
                    </p>
                  )}
                </div>
              )}

              {/* FR caption */}
              <div className="bg-white rounded-lg border shadow-sm p-5">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Français</h2>
                  <span className="text-xs text-gray-400">{selected.postText.length} chars</span>
                </div>
                <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{selected.postText}</p>
              </div>

              {/* EN caption (if available) */}
              {selected.postTextEn && (
                <div className="bg-white rounded-lg border shadow-sm p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">English</h2>
                    <span className="text-xs text-gray-400">{selected.postTextEn.length} chars</span>
                  </div>
                  <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{selected.postTextEn}</p>
                </div>
              )}

              {/* Review notes (if rejected) */}
              {selected.reviewNotes && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
                  <span className="font-medium">Notes: </span>{selected.reviewNotes}
                </div>
              )}

              {/* Publish feedback */}
              {publishFeedback && (
                <div className={`rounded-lg p-4 text-sm border ${
                  publishFeedback.type === "success"
                    ? "bg-green-50 border-green-200 text-green-800"
                    : publishFeedback.type === "partial"
                    ? "bg-yellow-50 border-yellow-200 text-yellow-800"
                    : "bg-red-50 border-red-200 text-red-800"
                }`}>
                  <div className="flex items-start justify-between gap-2">
                    <span>{publishFeedback.type === "success" ? "✓" : publishFeedback.type === "partial" ? "⚠" : "✕"} {publishFeedback.message}</span>
                    <button onClick={() => setPublishFeedback(null)} className="shrink-0 opacity-60 hover:opacity-100">✕</button>
                  </div>
                </div>
              )}

              {/* Actions (only for reviewable statuses) */}
              {(selected.status === "draft" || selected.status === "approved" || selected.status === "rejected") && (
                <div className="space-y-3">
                  {!showRejectInput ? (
                    <div className="flex gap-3 flex-wrap">
                      {selected.status !== "approved" && (
                        <button
                          onClick={handleApprove}
                          disabled={actionLoading}
                          className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium py-2.5 px-4 rounded-lg transition-colors"
                        >
                          {actionLoading ? "…" : "✓ Approuver"}
                        </button>
                      )}
                      {selected.status === "approved" && (() => {
                        const hasFR = !!selected.postText?.trim();
                        const hasEN = !!selected.postTextEn?.trim();
                        return (
                          <>
                            {hasFR && (
                              <button
                                onClick={() => { setPublishFeedback(null); setPendingLanguage("fr"); }}
                                disabled={actionLoading}
                                className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium py-2.5 px-4 rounded-lg transition-colors"
                              >
                                {actionLoading ? "Publication…" : "📢 Ameublo (FR)"}
                              </button>
                            )}
                            {hasEN && (
                              <button
                                onClick={() => { setPublishFeedback(null); setPendingLanguage("en"); }}
                                disabled={actionLoading}
                                className="flex-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium py-2.5 px-4 rounded-lg transition-colors"
                              >
                                {actionLoading ? "Publication…" : "📢 Furnish (EN)"}
                              </button>
                            )}
                            {hasFR && hasEN && (
                              <button
                                onClick={() => { setPublishFeedback(null); setPendingLanguage("both"); }}
                                disabled={actionLoading}
                                className="flex-1 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-medium py-2.5 px-4 rounded-lg transition-colors"
                              >
                                {actionLoading ? "Publication…" : "📢 Les deux (FR + EN)"}
                              </button>
                            )}
                          </>
                        );
                      })()}
                      {selected.status !== "rejected" && (
                        <button
                          onClick={() => setShowRejectInput(true)}
                          disabled={actionLoading}
                          className="flex-1 bg-white hover:bg-red-50 disabled:opacity-50 text-red-600 border border-red-300 text-sm font-medium py-2.5 px-4 rounded-lg transition-colors"
                        >
                          ✕ Rejeter
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <textarea
                        value={rejectNotes}
                        onChange={(e) => setRejectNotes(e.target.value)}
                        placeholder="Raison du rejet (obligatoire)…"
                        rows={3}
                        className="w-full text-sm border border-gray-300 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={handleReject}
                          disabled={actionLoading || !rejectNotes.trim()}
                          className="flex-1 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors"
                        >
                          {actionLoading ? "…" : "Confirmer le rejet"}
                        </button>
                        <button
                          onClick={() => { setShowRejectInput(false); setRejectNotes(""); }}
                          className="px-4 py-2 text-sm text-gray-600 border rounded-lg hover:bg-gray-50"
                        >
                          Annuler
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Scheduled state — show schedule info + cancel */}
              {selected.status === "scheduled" && selected.scheduledAt != null && (
                <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 flex items-center justify-between">
                  <div className="text-sm text-purple-900">
                    <span className="font-medium">📅 Planifié pour </span>
                    {formatDate(selected.scheduledAt)}
                  </div>
                  <button
                    onClick={handleCancelSchedule}
                    disabled={actionLoading}
                    className="text-sm text-purple-700 hover:text-purple-900 font-medium underline disabled:opacity-50"
                  >
                    {actionLoading ? "…" : "Annuler la planification"}
                  </button>
                </div>
              )}

              {/* Schedule input — available for unreviewed or approved drafts */}
              {(selected.status === "draft" || selected.status === "approved") && !showRejectInput && (
                <div className="bg-white rounded-lg border shadow-sm p-5">
                  <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
                    Planifier la publication
                  </h3>
                  <p className="text-xs text-gray-500 mb-3">
                    La publication automatique se fait sur les canaux configurés (Settings → Auto-post).
                    Vérification toutes les 15 minutes.
                  </p>
                  <div className="flex gap-2 flex-wrap">
                    <input
                      type="datetime-local"
                      value={scheduledAt}
                      min={toLocalInputValue(Math.floor(Date.now() / 1000) + 60)}
                      onChange={(e) => setScheduledAt(e.target.value)}
                      className="flex-1 min-w-[200px] text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                    <button
                      onClick={handleSchedule}
                      disabled={actionLoading || !scheduledAt}
                      className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors"
                    >
                      {actionLoading ? "…" : "📅 Planifier"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Publish confirm modal */}
      {pendingLanguage && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              {pendingLanguage === "fr" && "Publier sur Ameublo (FR)"}
              {pendingLanguage === "en" && "Publier sur Furnish Direct (EN)"}
              {pendingLanguage === "both" && "Publier sur les deux pages"}
            </h3>
            <p className="text-sm text-gray-600 mb-1">
              {pendingLanguage === "fr" && "Ce draft sera publié immédiatement sur la page Ameublo (français seulement)."}
              {pendingLanguage === "en" && "Ce draft sera publié immédiatement sur la page Furnish Direct (anglais seulement)."}
              {pendingLanguage === "both" && "Ce draft sera publié immédiatement sur Ameublo (FR) et Furnish Direct (EN)."}
            </p>
            <p className="text-sm text-gray-600 mb-5">
              <strong className="text-gray-800">Cette action est irréversible.</strong>
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setPendingLanguage(null)}
                disabled={actionLoading}
                className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                Annuler
              </button>
              <button
                onClick={handlePublish}
                disabled={actionLoading}
                className={`px-4 py-2 text-sm text-white rounded-lg disabled:opacity-50 transition-colors font-medium ${
                  pendingLanguage === "fr" ? "bg-blue-600 hover:bg-blue-700" :
                  pendingLanguage === "en" ? "bg-indigo-600 hover:bg-indigo-700" :
                  "bg-purple-600 hover:bg-purple-700"
                }`}
              >
                {actionLoading ? "Publication…" : "Oui, publier"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
