"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// ─── Shared types (mirror /lib/database VideoJob) ────────────────────

type VideoEngine = "ffmpeg" | "kling" | "creatomate";
type VideoContentType = "product" | "lifestyle" | "promo";
type VideoLocale = "fr" | "en";
type VideoStatus =
  | "pending" | "generating" | "ready" | "error" | "approved" | "rejected";

interface VideoJob {
  id: number;
  engine: VideoEngine;
  content_type: VideoContentType;
  product_skus: string[];
  locale: VideoLocale;
  status: VideoStatus;
  video_url: string | null;
  video_path: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

type Tab = "generate" | "queue" | "library" | "publish";

const TABS: { key: Tab; label: string }[] = [
  { key: "generate", label: "Générer" },
  { key: "queue", label: "File d'attente" },
  { key: "library", label: "Bibliothèque" },
  { key: "publish", label: "Publier" },
];

// The "Générer" tab keeps the Slideshow engine in the dropdown, but its videos
// are now produced by the Claude Code terminal script (see GenerateInfoBox), so
// it no longer renders an in-app generation panel.
type GenEngine = VideoEngine | "slideshow";

const ENGINES: { value: GenEngine; label: string }[] = [
  { value: "ffmpeg", label: "FFmpeg (Gratuit)" },
  { value: "kling", label: "Kling (~$0.35)" },
  { value: "creatomate", label: "Creatomate (~$0.10)" },
  { value: "slideshow", label: "Slideshow (Gratuit)" },
];

// Reality notes shown under the engine selector — only Kling/Creatomate would
// run on Vercel (when their accounts exist); FFmpeg/Slideshow are local-only.
const ENGINE_NOTES: Record<GenEngine, string> = {
  ffmpeg: "⚠️ Génération locale uniquement (non disponible sur Vercel)",
  slideshow: "⚠️ Générées via le script Claude Code (voir l'encadré ci-dessus)",
  kling: "🔜 Nécessite un compte Kling AI actif",
  creatomate: "🔜 Nécessite un compte Creatomate payant",
};

const CONTENT_TYPES: { value: VideoContentType; label: string }[] = [
  { value: "product", label: "Produit" },
  { value: "lifestyle", label: "Lifestyle" },
  { value: "promo", label: "Promo" },
];

const STATUS_BADGE: Record<VideoStatus, string> = {
  pending: "bg-gray-800 text-gray-400 border-gray-700",
  generating: "bg-blue-900/40 text-blue-400 border-blue-800/50",
  ready: "bg-amber-900/40 text-amber-400 border-amber-800/50",
  approved: "bg-green-900/40 text-green-400 border-green-800/50",
  rejected: "bg-red-950/40 text-red-400 border-red-800/50",
  error: "bg-red-950/40 text-red-400 border-red-800/50",
};

const STATUS_LABEL: Record<VideoStatus, string> = {
  pending: "En attente",
  generating: "Génération…",
  ready: "Prête",
  approved: "Approuvée",
  rejected: "Rejetée",
  error: "Erreur",
};

const INPUT_CLASS =
  "w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

// ─── Slideshow video queue (publication_queue, content_type='video') ─────────

interface VideoQueueItem {
  id: number;
  content_id: string;
  status: string;
  scheduled_at: string;
  created_at: string;
  payload: { reelsVideoUrl?: string; caption?: string; brand?: string };
}

const QUEUE_STATUS_META: Record<string, { label: string; cls: string }> = {
  draft: { label: "📝 Brouillon", cls: "bg-gray-800 text-gray-300 border-gray-700" },
  pending: { label: "⏳ Planifié", cls: "bg-blue-900/40 text-blue-300 border-blue-800/50" },
  publishing: { label: "📤 Publication…", cls: "bg-blue-900/40 text-blue-300 border-blue-800/50" },
  published: { label: "✅ Publié", cls: "bg-green-900/40 text-green-300 border-green-800/50" },
  failed: { label: "❌ Échec", cls: "bg-red-950/40 text-red-300 border-red-800/50" },
  cancelled: { label: "🚫 Annulé", cls: "bg-gray-800 text-gray-500 border-gray-700" },
};

/** Format a SQLite UTC datetime ('YYYY-MM-DD HH:MM:SS') for display (fr-CA). */
function formatSlot(sqliteUtc: string): string {
  const d = new Date(`${sqliteUtc.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime())
    ? sqliteUtc
    : d.toLocaleString("fr-CA", { dateStyle: "medium", timeStyle: "short" });
}

/** Format a unix-seconds slot (queue-reel `scheduledAt`) for display (fr-CA). */
function formatUnixSlot(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return Number.isNaN(d.getTime())
    ? String(unixSeconds)
    : d.toLocaleString("fr-CA", { dateStyle: "medium", timeStyle: "short" });
}

export default function VideosClient() {
  const [tab, setTab] = useState<Tab>("generate");
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [loading, setLoading] = useState(true);
  // Transient banner shown after a submit — lives in the parent so it survives
  // the redirect from "Générer" to "File d'attente" (the child unmounts).
  const [notice, setNotice] = useState<string | null>(null);

  // Slideshow video queue, lifted here so the tab badge, the queue tab, and the
  // library section all share one fetch + one approve/delete action.
  const [videoQueue, setVideoQueue] = useState<VideoQueueItem[]>([]);
  const [videoQueueLoading, setVideoQueueLoading] = useState(true);
  const [videoQueueError, setVideoQueueError] = useState<string | null>(null);
  const [actingVideoId, setActingVideoId] = useState<number | null>(null);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/videos?pageSize=100");
      const data = await res.json();
      if (data.success) setJobs(data.data.jobs);
    } catch {
      // ignore — transient fetch error, the next poll retries
    }
    setLoading(false);
  }, []);

  const loadVideoQueue = useCallback(async () => {
    try {
      const res = await fetch("/api/slideshow/queue");
      const d = await res.json();
      if (res.ok && Array.isArray(d.items)) {
        setVideoQueue(d.items);
        setVideoQueueError(null);
      } else {
        setVideoQueueError(d.error || "Échec du chargement de la file vidéo.");
      }
    } catch (err) {
      setVideoQueueError(String(err));
    } finally {
      setVideoQueueLoading(false);
    }
  }, []);

  /** Approve (POST) or cancel (DELETE) a slideshow video draft, then reload. */
  const actOnVideo = useCallback(
    async (id: number, method: "POST" | "DELETE") => {
      setActingVideoId(id);
      setVideoQueueError(null);
      try {
        const res = await fetch("/api/slideshow/approve", {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ queueId: id }),
        });
        const d = await res.json();
        if (!res.ok) setVideoQueueError(d.error || "Action échouée.");
        await loadVideoQueue();
      } catch (err) {
        setVideoQueueError(String(err));
      } finally {
        setActingVideoId(null);
      }
    },
    [loadVideoQueue],
  );

  useEffect(() => {
    fetchJobs();
    loadVideoQueue();
  }, [fetchJobs, loadVideoQueue]);

  // Poll while any job is mid-flight (pending/generating) so the queue stays live.
  useEffect(() => {
    const active = jobs.some((j) => j.status === "pending" || j.status === "generating");
    if (!active) return;
    const interval = setInterval(fetchJobs, 5000);
    return () => clearInterval(interval);
  }, [jobs, fetchJobs]);

  // Fine-grained 3s poll on each generating job's status endpoint so a finished
  // FFmpeg render flips to ready (and appears in the library) without waiting for
  // the slower full-list refresh above.
  useEffect(() => {
    const generatingIds = jobs.filter((j) => j.status === "generating").map((j) => j.id);
    if (generatingIds.length === 0) return;
    const interval = setInterval(async () => {
      const updates = await Promise.all(
        generatingIds.map(async (id) => {
          try {
            const res = await fetch(`/api/videos/${id}/status`);
            if (!res.ok) return null;
            const data = (await res.json()) as {
              status: VideoStatus;
              video_url: string | null;
              error_message: string | null;
            };
            return { id, ...data };
          } catch {
            return null; // transient — next tick retries
          }
        }),
      );
      setJobs((prev) =>
        prev.map((j) => {
          const u = updates.find((x) => x && x.id === j.id);
          return u
            ? { ...j, status: u.status, video_url: u.video_url, error_message: u.error_message }
            : j;
        }),
      );
    }, 3000);
    return () => clearInterval(interval);
  }, [jobs]);

  const queueJobs = jobs.filter((j) => j.status === "pending" || j.status === "generating");
  const libraryJobs = jobs.filter(
    (j) =>
      j.status === "ready" ||
      j.status === "approved" ||
      j.status === "rejected" ||
      j.status === "error",
  );
  const approvedJobs = jobs.filter((j) => j.status === "approved");

  const videoDraftCount = videoQueue.filter((it) => it.status === "draft").length;
  const visibleVideoCount = videoQueue.filter((it) => it.status !== "cancelled").length;

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-white">Vidéos</h2>
        <p className="text-gray-400 text-sm mt-0.5">
          Génère, révise et publie des vidéos produit, lifestyle et promo.
        </p>
      </div>

      {notice && (
        <div className="mb-4 p-3 rounded-lg text-sm border bg-blue-950/30 border-blue-800/50 text-blue-300">
          {notice}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-800 mb-6 overflow-x-auto">
        {TABS.map((t) => {
          const count =
            t.key === "queue" ? queueJobs.length + videoDraftCount
            : t.key === "library" ? libraryJobs.length + visibleVideoCount
            : t.key === "publish" ? approvedJobs.length
            : 0;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
                tab === t.key
                  ? "border-blue-500 text-blue-400"
                  : "border-transparent text-gray-400 hover:text-white"
              }`}
            >
              {t.label}
              {count > 0 && (
                <span className="ml-1.5 text-xs text-gray-500">({count})</span>
              )}
            </button>
          );
        })}
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm">Chargement…</p>
      ) : (
        <>
          {tab === "generate" && (
            <GenerateTab
              onCreated={() => {
                fetchJobs();
                setNotice("Génération en cours…");
                setTab("queue"); // jump to the queue so the user watches it render
              }}
            />
          )}
          {tab === "queue" && (
            <QueueTab
              jobs={queueJobs}
              videoItems={videoQueue}
              videoLoading={videoQueueLoading}
              videoError={videoQueueError}
              draftCount={videoDraftCount}
              acting={actingVideoId}
              onAct={actOnVideo}
            />
          )}
          {tab === "library" && (
            <LibraryTab
              jobs={libraryJobs}
              onChange={fetchJobs}
              videoItems={videoQueue}
              videoLoading={videoQueueLoading}
              videoError={videoQueueError}
              acting={actingVideoId}
              onAct={actOnVideo}
            />
          )}
          {tab === "publish" && <PublishTab jobs={approvedJobs} />}
        </>
      )}
    </div>
  );
}

// ─── Générer ─────────────────────────────────────────────────────────

interface ProductHit {
  sku: string;
  name: string;
  image1?: string;
}

/** Reality check: how slideshow videos are actually produced (Claude Code, local). */
function GenerateInfoBox() {
  return (
    <div className="rounded-xl border border-amber-700/40 bg-[#1A2340] p-4">
      <div className="flex items-start gap-3">
        <span className="text-2xl leading-none">🎬</span>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-[#D4A853]">
            Générer des vidéos avec Claude Code
          </h3>
          <p className="text-xs text-gray-300 leading-relaxed">
            Les vidéos slideshow sont générées localement via Claude Code (FFmpeg ne
            tourne pas sur Vercel). Lance le script&nbsp;:
          </p>
          <pre className="text-[11px] text-amber-200/90 bg-black/40 border border-amber-800/30 rounded-lg p-2.5 overflow-x-auto whitespace-pre-wrap break-all">
{`node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs \\
  scripts/generate-slideshow-batch.mts --dry-run`}
          </pre>
          <p className="text-xs text-gray-400 leading-relaxed">
            Les vidéos apparaîtront dans la <span className="text-gray-200 font-medium">Bibliothèque</span>{" "}
            après génération, puis dans la <span className="text-gray-200 font-medium">File d&apos;attente</span>{" "}
            pour approbation.
          </p>
        </div>
      </div>
    </div>
  );
}

function GenerateTab({ onCreated }: { onCreated: () => void }) {
  const [engine, setEngine] = useState<GenEngine>("ffmpeg");
  const [contentType, setContentType] = useState<VideoContentType>("product");
  const [localeChoice, setLocaleChoice] = useState<"fr" | "en" | "both">("fr");
  const [skus, setSkus] = useState<ProductHit[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function handleGenerate() {
    setMessage(null);
    setSubmitting(true);
    const locales: VideoLocale[] = localeChoice === "both" ? ["fr", "en"] : [localeChoice];
    const productSkus = skus.map((s) => s.sku);
    try {
      for (const locale of locales) {
        // FFmpeg and Kling render a real video right away via the generate
        // endpoint (async — returns a jobId and flips the job to "generating").
        // Creatomate still just queues a pending job through /api/videos.
        const rendersInline = engine === "ffmpeg" || engine === "kling";
        const res = rendersInline
          ? await fetch("/api/videos/generate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ engine, productSkus, locale }),
            })
          : await fetch("/api/videos", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ engine, contentType, locale, productSkus }),
            });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
      }
      // Success feedback ("Génération en cours…") + the redirect to the queue are
      // handled by the parent via onCreated (this tab unmounts on redirect).
      setSkus([]);
      onCreated();
    } catch (err) {
      setMessage({ kind: "err", text: err instanceof Error ? err.message : "Échec de la création" });
    }
    setSubmitting(false);
  }

  return (
    <div className="max-w-xl space-y-5">
      <GenerateInfoBox />

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1.5">Moteur</label>
        <select value={engine} onChange={(e) => setEngine(e.target.value as GenEngine)} className={INPUT_CLASS}>
          {ENGINES.map((e) => (
            <option key={e.value} value={e.value}>{e.label}</option>
          ))}
        </select>
        <p className="mt-1.5 text-xs text-amber-400/90">{ENGINE_NOTES[engine]}</p>
      </div>

      {/* Slideshow videos come from the Claude Code script (see the info box) —
          no in-app generation panel. The other engines keep their form. */}
      {engine === "slideshow" ? (
        <p className="text-sm text-gray-400">
          La génération slideshow se fait en terminal via Claude Code. Une fois générées,
          retrouve les vidéos dans la <span className="text-gray-200">Bibliothèque</span> et
          approuve-les dans la <span className="text-gray-200">File d&apos;attente</span>.
        </p>
      ) : (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Type</label>
            <select value={contentType} onChange={(e) => setContentType(e.target.value as VideoContentType)} className={INPUT_CLASS}>
              {CONTENT_TYPES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Produits</label>
            <ProductSearch selected={skus} onChange={setSkus} />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Langue</label>
            <div className="flex gap-2">
              {([
                { value: "fr", label: "FR" },
                { value: "en", label: "EN" },
                { value: "both", label: "Les deux" },
              ] as const).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setLocaleChoice(opt.value)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                    localeChoice === opt.value
                      ? "bg-blue-600/15 border-blue-600/50 text-blue-400"
                      : "bg-gray-900 border-gray-800 text-gray-400 hover:text-white"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {message && (
            <div
              className={`p-3 rounded-lg text-sm border ${
                message.kind === "ok"
                  ? "bg-green-950/30 border-green-800/50 text-green-300"
                  : "bg-red-950/30 border-red-800/50 text-red-300"
              }`}
            >
              {message.text}
            </div>
          )}

          <button
            onClick={handleGenerate}
            disabled={submitting}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
          >
            {submitting ? "Création…" : "Générer"}
          </button>
        </>
      )}
    </div>
  );
}

function ProductSearch({
  selected,
  onChange,
}: {
  selected: ProductHit[];
  onChange: (hits: ProductHit[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/catalog?search=${encodeURIComponent(q)}&limit=8`,
          { signal: ctrl.signal },
        );
        const data = await res.json();
        if (data.success) {
          setHits(data.data.products.map((p: ProductHit) => ({ sku: p.sku, name: p.name, image1: p.image1 })));
          setOpen(true);
        }
      } catch {
        // aborted or transient — ignore
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function add(hit: ProductHit) {
    if (!selected.some((s) => s.sku === hit.sku)) onChange([...selected, hit]);
    setQuery("");
    setHits([]);
    setOpen(false);
  }

  function remove(sku: string) {
    onChange(selected.filter((s) => s.sku !== sku));
  }

  return (
    <div ref={ref} className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => hits.length > 0 && setOpen(true)}
        placeholder="Rechercher par nom ou SKU…"
        className={INPUT_CLASS}
      />
      {open && hits.length > 0 && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-gray-900 border border-gray-700 rounded-lg shadow-2xl max-h-64 overflow-y-auto">
          {hits.map((hit) => (
            <button
              key={hit.sku}
              type="button"
              onClick={() => add(hit)}
              className="w-full text-left px-3 py-2 hover:bg-gray-800 flex items-center gap-2"
            >
              <span className="text-xs font-mono text-gray-500 shrink-0">{hit.sku}</span>
              <span className="text-sm text-gray-300 truncate">{hit.name}</span>
            </button>
          ))}
        </div>
      )}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {selected.map((s) => (
            <span
              key={s.sku}
              className="inline-flex items-center gap-1.5 px-2 py-1 bg-gray-800 border border-gray-700 rounded-md text-xs text-gray-300"
            >
              <span className="font-mono text-gray-500">{s.sku}</span>
              <button
                type="button"
                onClick={() => remove(s.sku)}
                aria-label={`Retirer ${s.sku}`}
                className="text-gray-500 hover:text-red-400"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── File d'attente ──────────────────────────────────────────────────

interface VideoSectionProps {
  videoItems: VideoQueueItem[];
  videoLoading: boolean;
  videoError: string | null;
  acting: number | null;
  onAct: (id: number, method: "POST" | "DELETE") => void;
}

function QueueTab({
  jobs,
  draftCount,
  videoItems,
  videoLoading,
  videoError,
  acting,
  onAct,
}: { jobs: VideoJob[]; draftCount: number } & VideoSectionProps) {
  // Approval view: the actionable / scheduled slideshow videos (skip published,
  // failed, cancelled — those live in the Bibliothèque).
  const pending = videoItems.filter(
    (it) => it.status === "draft" || it.status === "pending" || it.status === "publishing",
  );

  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-3">
          {draftCount > 0
            ? `${draftCount} vidéo${draftCount > 1 ? "s" : ""} en attente d’approbation`
            : "Vidéos en attente d’approbation"}
        </h3>
        {videoError && <p className="text-xs text-red-400 mb-2">{videoError}</p>}
        {videoLoading ? (
          <p className="text-gray-500 text-sm">Chargement…</p>
        ) : pending.length === 0 ? (
          <EmptyState text="Aucune vidéo slideshow en attente. Génère-en via le script Claude Code (onglet Générer)." />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {pending.map((it) => (
              <SlideshowVideoCard key={it.id} item={it} acting={acting} onAct={onAct} />
            ))}
          </div>
        )}
      </div>

      {/* Legacy render jobs (FFmpeg / Kling / Creatomate via video_jobs). */}
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Jobs de rendu (FFmpeg / Kling / Creatomate)</h3>
        {jobs.length === 0 ? (
          <EmptyState text="Aucun job de rendu en attente." />
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => (
              <div
                key={job.id}
                className="p-4 bg-gray-900 border border-gray-800 rounded-xl flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={job.status} />
                    <span className="text-sm text-gray-300">
                      {engineLabel(job.engine)} · {contentTypeLabel(job.content_type)} · {job.locale.toUpperCase()}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1 truncate">
                    {job.product_skus.length > 0 ? job.product_skus.join(", ") : "Aucun SKU"}
                  </p>
                </div>
                {job.engine === "kling" && job.status === "generating" && (
                  <div className="w-40 shrink-0">
                    <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div className="h-full w-1/3 bg-blue-500 rounded-full animate-pulse" />
                    </div>
                    <p className="text-[10px] text-gray-500 mt-1 text-right">Génération Kling…</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One slideshow-video card (publication_queue, content_type='video'). */
function SlideshowVideoCard({
  item,
  acting,
  onAct,
}: {
  item: VideoQueueItem;
  acting: number | null;
  onAct: (id: number, method: "POST" | "DELETE") => void;
}) {
  const meta = QUEUE_STATUS_META[item.status] ?? {
    label: item.status,
    cls: "bg-gray-800 text-gray-400 border-gray-700",
  };
  const url = item.payload.reelsVideoUrl;
  const title = item.payload.caption || item.content_id;
  const busy = acting === item.id;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col">
      <div className="aspect-video bg-gray-950 flex items-center justify-center">
        {url?.startsWith("https://") ? (
          <video src={url} controls preload="metadata" className="w-full h-full object-contain" />
        ) : (
          <span className="text-xs text-gray-600">Aperçu indisponible</span>
        )}
      </div>
      <div className="p-3 flex-1 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${meta.cls}`}>
            {meta.label}
          </span>
          {item.payload.brand && <span className="text-xs text-gray-500">{item.payload.brand}</span>}
        </div>
        <p className="text-xs text-gray-400 line-clamp-2" title={title}>{title}</p>
        {item.status === "pending" && (
          <p className="text-xs text-blue-300">Planifié le {formatSlot(item.scheduled_at)}</p>
        )}
        {item.status === "published" && (
          <p className="text-xs text-green-300">✅ Publié le {formatSlot(item.scheduled_at)}</p>
        )}
        {item.status === "draft" && (
          <div className="flex flex-wrap gap-2 mt-auto pt-1">
            <button
              onClick={() => onAct(item.id, "POST")}
              disabled={busy}
              className="px-2.5 py-1 text-xs font-medium bg-green-900/40 hover:bg-green-900/60 text-green-400 border border-green-800/50 rounded-md transition-colors disabled:opacity-50"
            >
              {busy ? "…" : "✅ Approuver"}
            </button>
            <button
              onClick={() => onAct(item.id, "DELETE")}
              disabled={busy}
              className="px-2.5 py-1 text-xs font-medium bg-red-950/40 hover:bg-red-950/60 text-red-400 border border-red-800/50 rounded-md transition-colors disabled:opacity-50"
            >
              {busy ? "…" : "🗑️ Supprimer"}
            </button>
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
        )}
      </div>
    </div>
  );
}

// ─── Bibliothèque ────────────────────────────────────────────────────

function LibraryTab({
  jobs,
  onChange,
  videoItems,
  videoLoading,
  videoError,
  acting,
  onAct,
}: { jobs: VideoJob[]; onChange: () => void } & VideoSectionProps) {
  async function setStatus(id: number, status: VideoStatus) {
    await fetch(`/api/videos/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    onChange();
  }

  const slideshows = videoItems.filter((it) => it.status !== "cancelled");

  return (
    <div className="space-y-10">
      {/* Section A — generated slideshows (publication_queue, content_type='video'). */}
      <section>
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Slideshows générés</h3>
        {videoError && <p className="text-xs text-red-400 mb-2">{videoError}</p>}
        {videoLoading ? (
          <p className="text-gray-500 text-sm">Chargement…</p>
        ) : slideshows.length === 0 ? (
          <EmptyState text="Aucun slideshow généré. Lance le script Claude Code (onglet Générer)." />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {slideshows.map((it) => (
              <SlideshowVideoCard key={it.id} item={it} acting={acting} onAct={onAct} />
            ))}
          </div>
        )}
      </section>

      {/* Section B — Demand Gen video assets (video_demand_gen). */}
      <DemandGenLibrarySection />

      {/* Legacy render jobs (FFmpeg / Kling / Creatomate via video_jobs). */}
      <section>
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Rendus FFmpeg / Kling / Creatomate</h3>
        {jobs.length === 0 ? (
          <EmptyState text="Aucune vidéo dans la bibliothèque." />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {jobs.map((job) => (
              <div key={job.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col">
                <div className="aspect-video bg-gray-950 flex items-center justify-center">
                  {job.video_url ? (
                    <video src={job.video_url} controls className="w-full h-full object-contain" />
                  ) : (
                    <span className="text-xs text-gray-600">Aperçu indisponible</span>
                  )}
                </div>
                <div className="p-3 flex-1 flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <StatusBadge status={job.status} />
                    <span className="text-xs text-gray-500">
                      {engineLabel(job.engine)} · {job.locale.toUpperCase()}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 truncate">
                    {contentTypeLabel(job.content_type)}
                    {job.product_skus.length > 0 && ` · ${job.product_skus.join(", ")}`}
                  </p>
                  {job.status === "error" && job.error_message && (
                    <p className="text-xs text-red-400 break-words" title={job.error_message}>
                      {job.error_message}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2 mt-auto pt-1">
                    {job.status !== "approved" && (
                      <button
                        onClick={() => setStatus(job.id, "approved")}
                        className="px-2.5 py-1 text-xs font-medium bg-green-900/40 hover:bg-green-900/60 text-green-400 border border-green-800/50 rounded-md transition-colors"
                      >
                        Approuver
                      </button>
                    )}
                    {job.status !== "rejected" && (
                      <button
                        onClick={() => setStatus(job.id, "rejected")}
                        className="px-2.5 py-1 text-xs font-medium bg-red-950/40 hover:bg-red-950/60 text-red-400 border border-red-800/50 rounded-md transition-colors"
                      >
                        Rejeter
                      </button>
                    )}
                    {job.video_url && (
                      <a
                        href={job.video_url}
                        download
                        className="px-2.5 py-1 text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 rounded-md transition-colors"
                      >
                        Télécharger
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Demand Gen library section (video_demand_gen) ───────────────────

interface DemandGenAssetDTO {
  id: number;
  sku: string;
  titleFr: string | null;
  ratio: string;
  durationSec: number;
  bytes: number | null;
  blobUrl: string;
  metaUploaded: boolean;
  youtubeUploaded: boolean;
}

const REEL_RATIO = "9:16";

function DemandGenLibrarySection() {
  const [assets, setAssets] = useState<DemandGenAssetDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Reel-publish state keyed by `${asset.id}:${language}`.
  const [reel, setReel] = useState<Record<string, { status: "loading" | "done" | "error"; message: string }>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/demand-gen-videos");
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json.success) setError(json.error || "Échec du chargement");
        else setAssets(json.data as DemandGenAssetDTO[]);
      } catch {
        if (!cancelled) setError("Échec du chargement");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function queueReel(asset: DemandGenAssetDTO, language: "fr" | "en") {
    const key = `${asset.id}:${language}`;
    // EN has no stored title, and a FR asset without title_fr also needs one.
    let caption: string | undefined;
    if (language === "en" || !asset.titleFr) {
      const input = window.prompt(
        language === "en"
          ? `Légende (EN) pour le Reel — ${asset.sku} :`
          : `Légende (FR) pour le Reel — ${asset.sku} (aucun titre FR) :`,
        "",
      );
      if (input === null || input.trim() === "") return;
      caption = input.trim();
    }

    setReel((s) => ({ ...s, [key]: { status: "loading", message: "" } }));
    try {
      const res = await fetch("/api/social/queue-reel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku: asset.sku,
          ratio: REEL_RATIO,
          language,
          duration_sec: asset.durationSec,
          ...(caption ? { caption } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success) {
        const when = typeof json.scheduledAt === "number" ? `le ${formatUnixSlot(json.scheduledAt)}` : "";
        setReel((s) => ({ ...s, [key]: { status: "done", message: `Planifié ${when}`.trim() } }));
      } else {
        setReel((s) => ({ ...s, [key]: { status: "error", message: json.error || `Erreur ${res.status}` } }));
      }
    } catch {
      setReel((s) => ({ ...s, [key]: { status: "error", message: "Erreur réseau" } }));
    }
  }

  // 6 most recent (higher autoincrement id = newer).
  const recent = [...assets].sort((a, b) => b.id - a.id).slice(0, 6);

  return (
    <section>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-gray-300">Vidéos Demand Gen</h3>
        <a href="/demand-gen-videos" className="text-xs text-blue-400 hover:text-blue-300">
          Voir la bibliothèque complète →
        </a>
      </div>
      {loading ? (
        <p className="text-gray-500 text-sm">Chargement…</p>
      ) : error ? (
        <p className="text-xs text-red-400">{error}</p>
      ) : recent.length === 0 ? (
        <EmptyState text="Aucune vidéo Demand Gen." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {recent.map((a) => {
            const canReel = a.ratio === REEL_RATIO && a.blobUrl.startsWith("https://");
            return (
              <div key={a.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col">
                <div className="aspect-video bg-gray-950 flex items-center justify-center">
                  {a.blobUrl.startsWith("https://") ? (
                    <video src={a.blobUrl} controls preload="metadata" className="w-full h-full object-contain" />
                  ) : (
                    <span className="text-xs text-gray-600">Aperçu indisponible</span>
                  )}
                </div>
                <div className="p-3 flex-1 flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-mono text-gray-300">{a.sku}</span>
                    <span className="text-xs text-gray-500">{a.ratio} · {a.durationSec}s</span>
                  </div>
                  {a.titleFr && (
                    <p className="text-xs text-gray-400 line-clamp-2" title={a.titleFr}>{a.titleFr}</p>
                  )}
                  {canReel ? (
                    <div className="mt-auto pt-1 flex flex-col gap-1">
                      <div className="flex gap-2">
                        {(["fr", "en"] as const).map((lang) => {
                          const st = reel[`${a.id}:${lang}`];
                          const busy = st?.status === "loading";
                          const done = st?.status === "done";
                          return (
                            <button
                              key={lang}
                              type="button"
                              onClick={() => queueReel(a, lang)}
                              disabled={busy || done}
                              className="px-2.5 py-1 text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {busy ? "…" : `📱 Reel ${lang.toUpperCase()}`}
                            </button>
                          );
                        })}
                      </div>
                      {(["fr", "en"] as const).map((lang) => {
                        const st = reel[`${a.id}:${lang}`];
                        if (!st || st.status === "loading") return null;
                        return (
                          <span key={lang} className={`text-xs ${st.status === "done" ? "text-green-400" : "text-red-400"}`}>
                            {lang.toUpperCase()}: {st.status === "done" ? `✅ ${st.message}` : `❌ ${st.message}`}
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="mt-auto pt-1 text-xs text-gray-600">Reel disponible pour les vidéos 9:16</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ─── Publier ─────────────────────────────────────────────────────────

function PublishTab({ jobs }: { jobs: VideoJob[] }) {
  if (jobs.length === 0) {
    return (
      <EmptyState text="Aucune vidéo approuvée. Approuvez d'abord une vidéo dans la Bibliothèque." />
    );
  }
  return (
    <div className="space-y-3 max-w-2xl">
      <p className="text-sm text-gray-400">
        Sélectionne les pages et planifie la publication des vidéos approuvées.
        La publication en Reel arrive dans une prochaine livraison.
      </p>
      {jobs.map((job) => (
        <div
          key={job.id}
          className="p-4 bg-gray-900 border border-gray-800 rounded-xl space-y-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-gray-300">
              {engineLabel(job.engine)} · {contentTypeLabel(job.content_type)} · {job.locale.toUpperCase()}
            </span>
            <StatusBadge status={job.status} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <select className={INPUT_CLASS} defaultValue="" disabled>
              <option value="">Pages (à venir)…</option>
            </select>
            <input type="datetime-local" className={INPUT_CLASS} disabled />
          </div>
          <button
            disabled
            className="px-4 py-2 bg-blue-600/40 text-white/60 text-sm font-medium rounded-lg cursor-not-allowed"
            title="Disponible une fois les moteurs de publication livrés"
          >
            Publier en Reel
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Shared bits ─────────────────────────────────────────────────────

function StatusBadge({ status }: { status: VideoStatus }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${STATUS_BADGE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="p-10 text-center text-gray-500 text-sm border border-dashed border-gray-800 rounded-xl">
      {text}
    </div>
  );
}

function engineLabel(engine: VideoEngine): string {
  return engine === "ffmpeg" ? "FFmpeg" : engine === "kling" ? "Kling" : "Creatomate";
}

function contentTypeLabel(ct: VideoContentType): string {
  return ct === "product" ? "Produit" : ct === "lifestyle" ? "Lifestyle" : "Promo";
}
