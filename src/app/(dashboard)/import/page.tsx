"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import DOMPurify from "isomorphic-dompurify";
import type { ImportJob } from "@/lib/import-pipeline";
import type { ImportBucket, ImportJobState } from "@/lib/import-job-state";
import {
  shouldTripCircuitBreaker,
  CIRCUIT_BREAKER_MIN_SAMPLE,
  CIRCUIT_BREAKER_THRESHOLD,
} from "@/lib/import-batch-guard";

const SHOPIFY_ADMIN_URL = "https://admin.shopify.com/store/27u5y2-kp";

/** Tabs = the real state of each job (import-job-state.ts), not the queue status. */
type Tab = "all" | ImportBucket;
const TABS: { key: Tab; label: string; color: string }[] = [
  { key: "all", label: "Tous", color: "text-white" },
  { key: "to_import", label: "À importer", color: "text-yellow-400" },
  { key: "live", label: "En ligne", color: "text-green-400" },
  { key: "hidden_in_stock", label: "Masqués mais en stock", color: "text-orange-400" },
  { key: "hidden_intentional", label: "Masqués (normal)", color: "text-gray-400" },
  { key: "problem", label: "Problèmes", color: "text-red-400" },
];
const PAGE_SIZE = 100;

interface BulkProgress {
  total: number;
  done: number;
  success: number;
  errors: number;
  /** Quality-gate failures (import-quality-gates.ts) — job landed on needs_review,
   * not published (or auto-unpublished). Counts toward the circuit breaker's failure
   * rate alongside `errors`, but is tracked separately since it isn't a crash. */
  needsReview: number;
  skipped: number;
  running: boolean;
  startedAt: number | null;
  errorList: { name: string; error: string }[];
  /** Set when the circuit breaker stopped the batch early — distinct from a manual Stop. */
  circuitBreakerTripped: boolean;
}

export default function ImportPage() {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<BulkProgress>({
    total: 0, done: 0, success: 0, errors: 0, needsReview: 0, skipped: 0,
    running: false, startedAt: null, errorList: [], circuitBreakerTripped: false,
  });
  const stopRef = useRef(false);
  // Real state per job (Shopify + Aosom feed). Loaded after the list — it needs a full
  // Shopify pass, so the list renders first and the badges/tabs fill in a few seconds later.
  const [states, setStates] = useState<Record<string, ImportJobState> | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [shown, setShown] = useState(PAGE_SIZE);

  async function fetchJobs() {
    try {
      const res = await fetch("/api/import/queue");
      const data = await res.json();
      setJobs(data.data || []);
    } catch {
      // ignore
    }
    setLoading(false);
  }

  async function fetchStates() {
    setStateError(null);
    try {
      const res = await fetch("/api/import/state");
      const data = await res.json();
      if (data.success) setStates(data.data);
      else setStateError(data.error || `HTTP ${res.status}`);
    } catch (err) {
      setStateError(err instanceof Error ? err.message : "Erreur réseau");
    }
  }

  useEffect(() => {
    fetchJobs();
    fetchStates();
  }, []);

  async function handleGenerate(jobId: string) {
    updateJobStatus(jobId, "generating");
    try {
      const res = await fetch("/api/import/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      const data = await res.json();
      if (data.success) {
        updateJob(data.data);
        setExpandedJob(jobId);
      } else {
        updateJobStatus(jobId, "error", data.error || `Génération refusée (HTTP ${res.status})`);
      }
    } catch (err) {
      updateJobStatus(
        jobId,
        "error",
        err instanceof Error ? `Réseau : ${err.message}` : "Erreur réseau pendant la génération",
      );
    }
  }

  async function handlePush(jobId: string) {
    updateJobStatus(jobId, "importing");
    try {
      const res = await fetch("/api/import/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      const data = await res.json();
      if (data.success) {
        updateJob(data.data);
      } else {
        updateJobStatus(jobId, "error", data.error || `Envoi Shopify refusé (HTTP ${res.status})`);
      }
    } catch (err) {
      // Un timeout ici ne veut PAS dire que rien n'a été créé : createShopifyProduct
      // peut avoir abouti côté Shopify malgré la coupure. Le message le dit, au lieu
      // d'inviter à un re-push qui créerait un doublon.
      updateJobStatus(
        jobId,
        "error",
        err instanceof Error
          ? `Réseau : ${err.message} — vérifiez dans Shopify avant de relancer`
          : "Erreur réseau — vérifiez dans Shopify avant de relancer",
      );
    }
  }

  // ─── Bulk Generate ───────────────────────────────────────────

  const startBulk = useCallback(async (jobIds: string[]) => {
    // Never regenerate/push a "pending" job whose product already exists on Shopify (the
    // queue status drifts — see import-job-state.ts); it would only burn an LLM call.
    const targets = jobs.filter(
      j => jobIds.includes(j.id) && j.status === "pending" && !(states?.[j.id]?.shopifyId),
    );
    if (targets.length === 0) return;

    if (!confirm(`You are about to generate and push ${targets.length} products to Shopify. Continue?`)) return;

    stopRef.current = false;
    setBulk({
      total: targets.length, done: 0, success: 0, errors: 0, needsReview: 0, skipped: 0,
      running: true, startedAt: Date.now(), errorList: [], circuitBreakerTripped: false,
    });

    let success = 0;
    let errors = 0;
    let needsReview = 0;
    const errorList: { name: string; error: string }[] = [];
    let circuitBreakerTripped = false;

    for (let i = 0; i < targets.length; i++) {
      if (stopRef.current) break;

      const job = targets[i];
      setBulk(prev => ({ ...prev, done: i }));

      try {
        // Step 1: Generate content
        updateJobStatus(job.id, "generating");
        const genRes = await fetch("/api/import/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: job.id }),
        });
        const genData = await genRes.json();
        if (!genData.success) throw new Error(genData.error || "Generate failed");
        updateJob(genData.data);

        // Step 2: Push to Shopify. importToShopify runs the pre-publish quality
        // gate (import-quality-gates.ts) before this even reaches Shopify, and a
        // post-publish safety net right after — a gate failure comes back as
        // `success: true` with `status: "needs_review"` (not an HTTP error), since
        // the request itself was handled correctly.
        updateJobStatus(job.id, "importing");
        const pushRes = await fetch("/api/import/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: job.id }),
        });
        const pushData = await pushRes.json();
        if (!pushData.success) throw new Error(pushData.error || "Push failed");
        updateJob(pushData.data);

        if (pushData.data.status === "needs_review") needsReview++;
        else success++;
      } catch (err) {
        errors++;
        errorList.push({
          name: job.product.name,
          error: err instanceof Error ? err.message : String(err),
        });
        updateJobStatus(job.id, "error");
      }

      const processed = i + 1;
      setBulk(prev => ({
        ...prev,
        done: processed,
        success,
        errors,
        needsReview,
        errorList: [...errorList],
      }));

      // Circuit breaker (import-quality-gates.ts) — see there for why MIN_SAMPLE
      // and THRESHOLD are what they are.
      if (shouldTripCircuitBreaker({ errors, needsReview, processed })) {
        circuitBreakerTripped = true;
        break;
      }

      // Rate limit pause (500ms between each)
      if (i < targets.length - 1 && !stopRef.current) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    setBulk(prev => ({ ...prev, running: false, circuitBreakerTripped }));
  }, [jobs, states]);

  function handleBulkAll() {
    const pendingIds = jobs.filter(j => j.status === "pending").map(j => j.id);
    startBulk(pendingIds);
  }

  function handleBulkSelected() {
    startBulk(Array.from(selected));
  }

  async function handleRetryFailed() {
    const failedIds = jobs.filter(j => j.status === "error").map(j => j.id);
    // Reset error jobs to pending first
    for (const j of jobs) {
      if (j.status === "error") {
        updateJobStatus(j.id, "pending");
      }
    }
    startBulk(failedIds);
  }

  function handleStop() {
    stopRef.current = true;
    setBulk(prev => ({ ...prev, running: false }));
  }

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllPending() {
    const pendingIds = jobs.filter(j => j.status === "pending").map(j => j.id);
    const allSelected = pendingIds.every(id => selected.has(id));
    setSelected(prev => {
      const next = new Set(prev);
      for (const id of pendingIds) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  function updateJob(updated: ImportJob) {
    setJobs(prev => prev.map(j => (j.id === updated.id ? updated : j)));
  }

  /**
   * The row already renders `job.error` (the red line under a failed job), but
   * this used to set `status` alone — so a failed Generate/Push showed the word
   * "error" and nothing else, with the paid LLM call or the Shopify write
   * already spent. Carry the reason so the operator knows whether to retry.
   */
  function updateJobStatus(jobId: string, status: string, error?: string) {
    setJobs(prev =>
      prev.map(j =>
        j.id === jobId
          ? {
              ...j,
              status: status as ImportJob["status"],
              ...(status === "error"
                ? { error: error ?? "Échec sans détail renvoyé par le serveur" }
                : {}),
            }
          : j
      )
    );
  }

  // ─── Computed values ─────────────────────────────────────────

  const pending = jobs.filter(j => j.status === "pending").length;
  const errored = jobs.filter(j => j.status === "error").length;
  const selectedPending = jobs.filter(j => selected.has(j.id) && j.status === "pending").length;

  const tabCounts: Record<Tab, number> = {
    all: jobs.length, to_import: 0, live: 0, hidden_in_stock: 0, hidden_intentional: 0, problem: 0,
  };
  if (states) for (const j of jobs) { const b = states[j.id]?.bucket; if (b) tabCounts[b]++; }
  const visibleJobs = tab === "all" || !states ? jobs : jobs.filter(j => states[j.id]?.bucket === tab);

  const etaSeconds = bulk.running && bulk.done > 0 && bulk.startedAt
    ? Math.round(((Date.now() - bulk.startedAt) / bulk.done) * (bulk.total - bulk.done) / 1000)
    : null;

  return (
    <div className="p-4 md:p-8 max-w-6xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Import Pipeline</h2>
          <p className="text-gray-400 text-sm mt-0.5">
            Generate content and push to Shopify
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          {errored > 0 && !bulk.running && (
            <button
              onClick={handleRetryFailed}
              className="w-full sm:w-auto px-4 py-2 bg-yellow-600 hover:bg-yellow-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Retry Failed ({errored})
            </button>
          )}
          {selectedPending > 0 && !bulk.running && (
            <button
              onClick={handleBulkSelected}
              className="w-full sm:w-auto px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Generate Selected ({selectedPending})
            </button>
          )}
          {pending > 0 && !bulk.running && (
            <button
              onClick={handleBulkAll}
              className="w-full sm:w-auto px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Generate All Pending ({pending})
            </button>
          )}
          {bulk.running && (
            <button
              onClick={handleStop}
              className="w-full sm:w-auto px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {/* Real-state tabs (Shopify + Aosom feed) — click to filter */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2 md:gap-3 mb-2">
        {TABS.map((t) => (
          <StatCard
            key={t.key}
            label={t.label}
            value={t.key === "all" || states ? tabCounts[t.key] : null}
            color={t.color}
            active={tab === t.key}
            onClick={() => { setTab(t.key); setShown(PAGE_SIZE); }}
          />
        ))}
      </div>
      <p className="text-xs text-gray-500 mb-6">
        {stateError ? (
          <span className="text-red-400">
            Vérification Shopify impossible : {stateError}{" "}
            <button onClick={fetchStates} className="underline">Réessayer</button>
          </span>
        ) : states ? (
          "État réel vérifié sur Shopify et dans le flux Aosom."
        ) : (
          "Vérification de l’état réel sur Shopify…"
        )}
      </p>

      {/* Bulk Progress Bar */}
      {(bulk.running || bulk.done > 0) && (
        <div className="mb-6 p-4 bg-gray-900 border border-gray-800 rounded-xl">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm text-white font-medium">
              {bulk.running ? "Generating..." : "Bulk Generate Complete"}
            </p>
            <p className="text-xs text-gray-400">
              {bulk.done}/{bulk.total} ({bulk.total > 0 ? Math.round(bulk.done / bulk.total * 100) : 0}%)
              {etaSeconds !== null && ` — ~${Math.floor(etaSeconds / 60)}m ${etaSeconds % 60}s remaining`}
            </p>
          </div>
          <div className="w-full bg-gray-800 rounded-full h-2.5 mb-3">
            <div
              className={`h-2.5 rounded-full transition-all duration-300 ${bulk.running ? "bg-blue-500" : "bg-green-500"}`}
              style={{ width: `${bulk.total > 0 ? (bulk.done / bulk.total) * 100 : 0}%` }}
            />
          </div>
          <div className="flex gap-4 text-xs">
            <span className="text-green-400">{bulk.success} success</span>
            <span className="text-amber-400">{bulk.needsReview} needs review</span>
            <span className="text-red-400">{bulk.errors} errors</span>
            <span className="text-gray-400">{bulk.total - bulk.done} remaining</span>
          </div>

          {/* Circuit breaker — stopped the rest of the batch rather than keep
              publishing against a likely systemic bug. Distinct from a manual Stop. */}
          {bulk.circuitBreakerTripped && (
            <div className="mt-3 p-3 bg-red-950/40 border border-red-800/60 rounded-lg">
              <p className="text-sm text-red-300 font-medium">
                ⚠ Lot arrêté automatiquement — taux d&apos;échec anormal
              </p>
              <p className="text-xs text-red-400/80 mt-1">
                Plus de {Math.round(CIRCUIT_BREAKER_THRESHOLD * 100)}% des produits traités ont échoué
                (erreur ou contrôle qualité) sur au moins {CIRCUIT_BREAKER_MIN_SAMPLE} produits — le reste
                du lot n&apos;a pas été publié. Vérifiez les erreurs/produits à réviser ci-dessous avant de relancer.
              </p>
            </div>
          )}

          {/* Error list */}
          {bulk.errorList.length > 0 && !bulk.running && (
            <div className="mt-3 border-t border-gray-800 pt-3">
              <p className="text-xs text-red-400 font-medium mb-1">Errors:</p>
              <div className="max-h-32 overflow-y-auto space-y-1">
                {bulk.errorList.map((e, i) => (
                  <p key={i} className="text-xs text-gray-400">
                    <span className="text-red-400">{e.name.slice(0, 60)}</span>: {e.error}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Jobs */}
      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="p-12 bg-gray-900 border border-gray-800 rounded-xl text-center">
          <p className="text-gray-500 text-sm">No products in the import queue</p>
          <p className="text-gray-600 text-xs mt-1">
            Select products from the Catalogue tab to start importing
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Select all header */}
          {pending > 0 && !bulk.running && (
            <div className="flex items-center gap-3 px-4 py-2">
              <input
                type="checkbox"
                onChange={selectAllPending}
                checked={pending > 0 && jobs.filter(j => j.status === "pending").every(j => selected.has(j.id))}
                className="rounded bg-gray-800 border-gray-700 text-blue-500"
              />
              <span className="text-xs text-gray-500">Select all pending</span>
            </div>
          )}

          {visibleJobs.length === 0 && (
            <div className="p-8 bg-gray-900 border border-gray-800 rounded-xl text-center text-sm text-gray-500">
              Rien dans cet onglet.
            </div>
          )}
          {visibleJobs.slice(0, shown).map((job) => (
            <div
              key={job.id}
              className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden"
            >
              {/* Header */}
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 p-4">
                {job.status === "pending" && !bulk.running && !states?.[job.id]?.shopifyId && (
                  <input
                    type="checkbox"
                    checked={selected.has(job.id)}
                    onChange={() => toggleSelect(job.id)}
                    className="rounded bg-gray-800 border-gray-700 text-blue-500 shrink-0"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <h4 className="text-sm font-medium text-white truncate">
                      {job.product.name}
                    </h4>
                    <ImportStatusBadge status={job.status} />
                  </div>
                  {states?.[job.id] && <RealStateLine state={states[job.id]} />}
                  <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                    <span>{job.product.brand}</span>
                    <span>{job.product.variants.length} variant(s)</span>
                    <span>
                      ${Math.min(...job.product.variants.map((v) => v.price))}
                      {job.product.variants.length > 1 &&
                        ` - $${Math.max(...job.product.variants.map((v) => v.price))}`}
                    </span>
                  </div>
                </div>
                <div className="flex gap-2 shrink-0 w-full sm:w-auto [&>*]:flex-1 sm:[&>*]:flex-none">
                  {job.status === "pending" && !bulk.running && !states?.[job.id]?.shopifyId && (
                    <button
                      onClick={() => handleGenerate(job.id)}
                      className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      Generate
                    </button>
                  )}
                  {job.status === "reviewing" && !states?.[job.id]?.shopifyId && (
                    <>
                      <button
                        onClick={() =>
                          setExpandedJob(
                            expandedJob === job.id ? null : job.id
                          )
                        }
                        className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        {expandedJob === job.id ? "Collapse" : "Review"}
                      </button>
                      <button
                        onClick={() => handlePush(job.id)}
                        className="px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        Push to Shopify
                      </button>
                    </>
                  )}
                  {(states?.[job.id]?.shopifyId ?? (job.status === "done" ? job.shopifyId : null)) && (
                    <a
                      href={`${SHOPIFY_ADMIN_URL}/products/${states?.[job.id]?.shopifyId ?? job.shopifyId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      View in Shopify
                    </a>
                  )}
                </div>
              </div>

              {/* Expanded content preview */}
              {expandedJob === job.id && job.content && (
                <div className="border-t border-gray-800 p-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <ContentPreview
                      lang="EN"
                      title={job.content.titleEn}
                      description={job.content.descriptionEn}
                      seoDescription={job.content.seoDescriptionEn}
                    />
                    <ContentPreview
                      lang="FR"
                      title={job.content.titleFr}
                      description={job.content.descriptionFr}
                      seoDescription={job.content.seoDescriptionFr}
                    />
                  </div>
                  {job.content.tags.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {job.content.tags.map((tag) => (
                        <span
                          key={tag}
                          className="px-2 py-0.5 bg-gray-800 rounded text-xs text-gray-400"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Error */}
              {job.error && (
                <div className="border-t border-red-800/30 px-4 py-3 bg-red-950/20">
                  <p className="text-xs text-red-400">{job.error}</p>
                </div>
              )}
            </div>
          ))}
          {visibleJobs.length > shown && (
            <button
              onClick={() => setShown((n) => n + PAGE_SIZE)}
              className="w-full py-2 bg-gray-900 border border-gray-800 hover:bg-gray-800 rounded-xl text-sm text-gray-300"
            >
              Afficher {Math.min(PAGE_SIZE, visibleJobs.length - shown)} de plus ({visibleJobs.length - shown} restants)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
  active,
  onClick,
}: {
  label: string;
  /** null = still loading. */
  value: number | null;
  color: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`p-3 md:p-4 text-left bg-gray-900 border rounded-xl transition-colors hover:bg-gray-800 ${
        active ? "border-blue-500" : "border-gray-800"
      }`}
    >
      <p className="text-[10px] md:text-xs text-gray-500">{label}</p>
      <p className={`text-xl md:text-2xl font-bold mt-1 ${color}`}>{value ?? "…"}</p>
    </button>
  );
}

const SHOPIFY_LABEL: Record<ImportJobState["shopify"], { text: string; cls: string }> = {
  live: { text: "Shopify : en ligne", cls: "text-green-400 border-green-800/50 bg-green-900/30" },
  hidden: { text: "Shopify : masqué", cls: "text-orange-400 border-orange-800/50 bg-orange-900/30" },
  archived: { text: "Shopify : archivé", cls: "text-gray-400 border-gray-700 bg-gray-800" },
  deleted: { text: "Shopify : supprimé", cls: "text-red-400 border-red-800/50 bg-red-900/30" },
  not_created: { text: "Shopify : pas créé", cls: "text-gray-400 border-gray-700 bg-gray-800" },
};
const FEED_LABEL: Record<ImportJobState["feed"], { text: string; cls: string }> = {
  in_stock: { text: "Aosom : en stock", cls: "text-green-400 border-green-800/50 bg-green-900/30" },
  out_of_stock: { text: "Aosom : rupture", cls: "text-amber-400 border-amber-800/50 bg-amber-900/30" },
  gone: { text: "Aosom : retiré du flux", cls: "text-red-400 border-red-800/50 bg-red-900/30" },
  unknown: { text: "Aosom : inconnu", cls: "text-gray-400 border-gray-700 bg-gray-800" },
};

/** Where the product really is (Shopify), whether Aosom still sells it, and why it's in its tab. */
function RealStateLine({ state }: { state: ImportJobState }) {
  const s = SHOPIFY_LABEL[state.shopify];
  const f = FEED_LABEL[state.feed];
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
      <span className={`px-1.5 py-0.5 rounded border text-[11px] ${s.cls}`}>{s.text}</span>
      <span className={`px-1.5 py-0.5 rounded border text-[11px] ${f.cls}`}>{f.text}</span>
      <span className="text-[11px] text-gray-400">{state.reason}</span>
    </div>
  );
}

function ImportStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: "bg-gray-800 text-gray-400 border-gray-700",
    generating: "bg-blue-900/40 text-blue-400 border-blue-800/50",
    reviewing: "bg-yellow-900/40 text-yellow-400 border-yellow-800/50",
    importing: "bg-blue-900/40 text-blue-400 border-blue-800/50",
    done: "bg-green-900/40 text-green-400 border-green-800/50",
    error: "bg-red-900/40 text-red-400 border-red-800/50",
    needs_review: "bg-amber-900/40 text-amber-400 border-amber-800/50",
  };

  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium border shrink-0 ${
        styles[status] || styles.error
      }`}
    >
      {status === "generating" ? "generating..." : status === "importing" ? "importing..." : status}
    </span>
  );
}

function ContentPreview({
  lang,
  title,
  description,
  seoDescription,
}: {
  lang: string;
  title: string;
  description: string;
  seoDescription: string;
}) {
  return (
    <div>
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
        {lang}
      </span>
      <h5 className="text-sm font-medium text-white mt-1">{title}</h5>
      <div
        className="text-xs text-gray-400 mt-2 max-h-40 overflow-y-auto prose prose-invert prose-xs"
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(description) }}
      />
      <div className="mt-3 p-2 bg-gray-800/50 rounded text-xs">
        <p className="text-gray-500">
          SEO: <span className="text-gray-300">{seoDescription}</span>
        </p>
      </div>
    </div>
  );
}
