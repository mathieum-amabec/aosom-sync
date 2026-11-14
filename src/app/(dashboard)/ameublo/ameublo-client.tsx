"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { SectionTabs, VIDEO_SECTION_TABS } from "@/components/section-tabs";
import { styleLabelOf } from "@/lib/ameublo-style-label";
import { markScheduled, markUnscheduled } from "@/lib/ameublo-studio-state";
import { CATEGORY_LABEL, CATEGORY_ORDER, type CategoryKey } from "@/lib/ameublo-categories";
import WeekPlanPanel from "./week-plan-panel";
import ResultsPanel from "./results-panel";

// Mirrors AmeubloTestVideo in src/lib/database.ts.
interface StudioVideo {
  id: number;
  series: string;
  sku: string | null;
  campaign: string | null;
  label: string | null;
  video_url: string;
  verdict: "ok" | "bad" | null;
  note: string | null;
  created_at: string;
  style: string | null;
  lang: "fr" | "en" | null;
  caption: string | null;
  skus: string[];
  music: string | null;
  queue_id: number | null;
  queue_status: string | null;
  queue_scheduled_at: string | null;
  qa_verdict: "pass" | "fail" | "review" | null;
  qa_notes: string | null;
  // Added by GET /api/ameublo/videos from the catalogue product types.
  category: CategoryKey;
  category_label: string;
  sub_category: string;
}

type Status = "new" | "scheduled" | "published" | "rejected" | "rerender" | "flagged";

function statusOf(v: StudioVideo): Status {
  if (v.queue_status === "published") return "published";
  if (v.queue_id != null && (v.queue_status === "pending" || v.queue_status === "publishing")) return "scheduled";
  if (v.verdict === "bad") return "rejected";
  if (v.queue_id != null && v.queue_status === "draft") return "rerender";
  if (v.qa_verdict === "fail" || v.qa_verdict === "review") return "flagged";
  return "new";
}

const STATUS_LABEL: Record<Status, string> = {
  new: "Nouveau",
  scheduled: "Planifié",
  published: "Publié",
  rejected: "Rejeté",
  rerender: "À re-rendre",
  flagged: "Écartée (QA)",
};
const STATUS_CLASS: Record<Status, string> = {
  new: "bg-blue-950/60 border-blue-800 text-blue-200",
  scheduled: "bg-green-950/60 border-green-800 text-green-200",
  published: "bg-gray-800 border-gray-600 text-gray-200",
  rejected: "bg-red-950/60 border-red-800 text-red-200",
  rerender: "bg-amber-950/60 border-amber-800 text-amber-200",
  flagged: "bg-gray-900 border-gray-700 text-gray-400",
};
const QA_CLASS = {
  pass: "bg-green-950/60 border-green-800 text-green-200",
  review: "bg-amber-950/60 border-amber-800 text-amber-200",
  fail: "bg-red-950/60 border-red-800 text-red-200",
} as const;
const QA_LABEL = { pass: "Réviseur : OK", review: "Réviseur : à voir", fail: "Réviseur : refusé" } as const;

const styleLabel = (s: string | null) => styleLabelOf(s, "fr");

function fmtWhen(sqlite: string | null): string {
  if (!sqlite) return "";
  const d = new Date(`${sqlite.replace(" ", "T")}Z`);
  return d.toLocaleString("fr-CA", {
    timeZone: "America/Toronto",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="text-xs text-gray-400 flex flex-col gap-1">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-200"
      >
        <option value="">Tous</option>
        {options.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function AmeubloStudioClient() {
  const [videos, setVideos] = useState<StudioVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | "bulk" | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Cards just approved/cancelled stay on screen under the current filter so the change is visible.
  const [recent, setRecent] = useState<Set<number>>(new Set());
  const busyRef = useRef(false);
  const [fStyle, setFStyle] = useState("");
  const [fLang, setFLang] = useState("");
  const [fSeries, setFSeries] = useState("");
  const [fCampaign, setFCampaign] = useState("");
  const [view, setView] = useState<"videos" | "plan" | "results">("videos");
  const [fStatus, setFStatus] = useState("new");
  const [fCategory, setFCategory] = useState("");
  const [fSub, setFSub] = useState("");
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const seriesInit = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/ameublo/videos");
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`);
      const list: StudioVideo[] = j.data.videos;
      setVideos(list);
      if (!seriesInit.current && list.length) {
        seriesInit.current = true;
        const latest = list.reduce((a, b) => (b.created_at > a.created_at ? b : a));
        if (latest.series) setFSeries(latest.series);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/ameublo/videos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok && j.success !== false, j, status: res.status };
  };

  const saveVerdict = async (id: number, verdict: "ok" | "bad" | null) => {
    const current = videos.find((v) => v.id === id);
    if (!current) return;
    setVideos((vs) => vs.map((v) => (v.id === id ? { ...v, verdict } : v)));
    const res = await fetch("/api/ameublo/videos", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, verdict }),
    });
    if (!res.ok) {
      setVideos((vs) => vs.map((v) => (v.id === id ? current : v)));
      const j = await res.json().catch(() => ({}));
      setError(j.error || `Échec de l'enregistrement (HTTP ${res.status})`);
    }
  };

  const approve = async (v: StudioVideo, force = false): Promise<void> => {
    if (busyRef.current && !force) return;
    busyRef.current = true;
    setBusy(v.id);
    setError(null);
    setInfo(null);
    try {
      const r = await post({ action: "approve", id: v.id, force });
      if (r.ok) {
        setVideos((vs) => markScheduled(vs, v.id, Number(r.j.queueId), String(r.j.scheduledAt)));
        setRecent((s) => new Set(s).add(v.id));
        setSelected((s) => {
          const n = new Set(s);
          n.delete(v.id);
          return n;
        });
        const tw = r.j.twin as { success: boolean; id: number; scheduledAt?: string; error?: string } | undefined;
        setInfo(
          `✓ Vidéo ${v.id} approuvée et planifiée : ${fmtWhen(r.j.scheduledAt)}.` +
            (tw ? (tw.success ? ` Version jumelle #${tw.id} planifiée : ${fmtWhen(String(tw.scheduledAt))}.` : ` Version jumelle #${tw.id} NON planifiée : ${tw.error}`) : ""),
        );
      } else if (v.qa_verdict === "fail" && !force && window.confirm(`${r.j.error}\n\nForcer l'approbation ?`)) {
        busyRef.current = false;
        return await approve(v, true);
      } else setError(r.j.error || `Échec (HTTP ${r.status})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
    await load();
  };

  const cancel = async (v: StudioVideo) => {
    setBusy(v.id);
    setError(null);
    setInfo(null);
    const r = await post({ action: "cancel", id: v.id });
    if (r.ok) {
      setVideos((vs) => markUnscheduled(vs, v.id));
      setRecent((s) => new Set(s).add(v.id));
      setInfo(`✓ Vidéo ${v.id} retirée de l'horaire.`);
    } else setError(r.j.error || `Échec (HTTP ${r.status})`);
    setBusy(null);
    await load();
  };

  const saveCaption = async (v: StudioVideo) => {
    const caption = drafts[v.id];
    if (caption == null || caption === (v.caption ?? "")) return;
    const r = await post({ action: "caption", id: v.id, caption });
    if (r.ok) {
      setVideos((vs) => vs.map((x) => (x.id === v.id ? { ...x, caption } : x)));
    } else setError(r.j.error || `Échec (HTTP ${r.status})`);
  };

  const options = useMemo(() => {
    const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
    return {
      styles: uniq(videos.map((v) => v.style)),
      series: uniq(videos.map((v) => v.series)),
      campaigns: uniq(videos.map((v) => v.campaign)),
    };
  }, [videos]);

  // Everything except series and category, so each category chip shows what clicking it would return
  // (a click clears the series filter, see pickCategory).
  const baseMatches = useMemo(
    () =>
      videos.filter(
        (v) =>
          (!fStyle || v.style === fStyle) &&
          (!fLang || v.lang === fLang) &&
          (!fCampaign || v.campaign === fCampaign) &&
          (!fStatus || statusOf(v) === fStatus || recent.has(v.id)),
      ),
    [videos, fStyle, fLang, fCampaign, fStatus, recent],
  );

  const shown = useMemo(
    () =>
      baseMatches.filter(
        (v) => (!fSeries || v.series === fSeries) && (!fCategory || v.category === fCategory) && (!fSub || v.sub_category === fSub),
      ),
    [baseMatches, fSeries, fCategory, fSub],
  );

  const categoryCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const v of baseMatches) c.set(v.category, (c.get(v.category) ?? 0) + 1);
    return c;
  }, [baseMatches]);

  const subCounts = useMemo(() => {
    const c = new Map<string, number>();
    if (fCategory) for (const v of baseMatches) if (v.category === fCategory) c.set(v.sub_category, (c.get(v.sub_category) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [baseMatches, fCategory]);

  // Picking a category looks across every series: the auto "latest series" filter would otherwise hide the other themes.
  const pickCategory = (key: string) => {
    setFCategory(fCategory === key ? "" : key);
    setFSub("");
    if (fCategory !== key) setFSeries("");
  };

  const counts = useMemo(() => {
    const c: Record<Status, number> = { new: 0, scheduled: 0, published: 0, rejected: 0, rerender: 0, flagged: 0 };
    for (const v of videos) c[statusOf(v)]++;
    return c;
  }, [videos]);

  const approvable = shown.filter((v) => statusOf(v) === "new" && v.lang && v.style && v.qa_verdict !== "fail");
  const selectedApprovable = approvable.filter((v) => selected.has(v.id));

  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const bulkApprove = async () => {
    const ids = selectedApprovable.map((v) => v.id).slice(0, 100);
    if (!ids.length) return;
    if (!window.confirm(`Planifier ${ids.length} vidéo(s) sur les prochains créneaux libres ?`)) return;
    setBusy("bulk");
    setError(null);
    setInfo(null);
    const r = await post({ action: "bulk_approve", ids });
    if (r.ok) {
      setInfo(`${r.j.data.approved} planifiée(s), ${r.j.data.refused} refusée(s) (chaque vidéo entraîne sa version dans l’autre langue).`);
      setSelected(new Set());
    } else setError(r.j.error || `Échec (HTTP ${r.status})`);
    setBusy(null);
    await load();
  };

  return (
    <div className="p-4 md:p-8 space-y-6">
      <SectionTabs tabs={VIDEO_SECTION_TABS} />

      <div>
        <h1 className="text-2xl font-bold text-white">Studio Ameublo</h1>
        <p className="text-sm text-gray-400 mt-1">
          Vidéos de la mascotte (Ameublo en français, Furni en anglais pour Furnish Direct). Rien ne part sans ton
          approbation : « Approuver et planifier » place la vidéo sur le prochain créneau libre de sa langue, et la
          publication se fait ensuite automatiquement (FB + IG).
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Horaire (heure de Toronto) : 3 Reels par page et par jour — 07 h 45 · 12 h 15 · 19 h 45 en FR (EN : +5 min), plus 06 h 00 réservé au saisonnier.
        </p>
      </div>

      <div className="flex gap-2 text-sm">
        {([["videos", "Vidéos"], ["plan", "Plan de la semaine"], ["results", "Résultats"]] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            className={`rounded border border-gray-700 px-3 py-1.5 ${view === key ? "bg-gray-800 text-white ring-1 ring-white/40" : "text-gray-300 hover:bg-gray-800"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "plan" ? (
        <WeekPlanPanel onApproved={load} />
      ) : view === "results" ? (
        <ResultsPanel />
      ) : (
      <>
      <div className="flex flex-wrap gap-2 text-xs">
        {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
          <button
            key={s}
            onClick={() => setFStatus(fStatus === s ? "" : s)}
            className={`rounded border px-2 py-1 ${STATUS_CLASS[s]} ${fStatus === s ? "ring-1 ring-white/60" : "opacity-80"}`}
          >
            {STATUS_LABEL[s]} · {counts[s]}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-gray-400">Catégorie</span>
          <button
            onClick={() => {
              setFCategory("");
              setFSub("");
            }}
            className={`rounded border border-gray-700 px-2 py-1 text-gray-200 ${fCategory === "" ? "ring-1 ring-white/60" : "opacity-80"}`}
          >
            Toutes · {baseMatches.length}
          </button>
          {CATEGORY_ORDER.filter((k) => categoryCounts.has(k)).map((k) => (
            <button
              key={k}
              onClick={() => pickCategory(k)}
              className={`rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-200 ${fCategory === k ? "ring-1 ring-white/60" : "opacity-80"}`}
            >
              {CATEGORY_LABEL[k]} · {categoryCounts.get(k)}
            </button>
          ))}
        </div>
        {fCategory && subCounts.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-gray-400">Sous-catégorie</span>
            <button
              onClick={() => setFSub("")}
              className={`rounded border border-gray-700 px-2 py-1 text-gray-200 ${fSub === "" ? "ring-1 ring-white/60" : "opacity-80"}`}
            >
              Toutes
            </button>
            {subCounts.map(([sub, n]) => (
              <button
                key={sub}
                onClick={() => setFSub(fSub === sub ? "" : sub)}
                className={`rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-200 ${fSub === sub ? "ring-1 ring-white/60" : "opacity-80"}`}
              >
                {sub} · {n}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Select label="Style" value={fStyle} onChange={setFStyle} options={options.styles.map((s) => [s, styleLabel(s)])} />
        <Select
          label="Langue"
          value={fLang}
          onChange={setFLang}
          options={[
            ["fr", "Français"],
            ["en", "English"],
          ]}
        />
        <Select label="Série" value={fSeries} onChange={setFSeries} options={options.series.map((s) => [s, s])} />
        <Select label="Campagne" value={fCampaign} onChange={setFCampaign} options={options.campaigns.map((s) => [s, s])} />
        <Select
          label="Statut"
          value={fStatus}
          onChange={setFStatus}
          options={(Object.keys(STATUS_LABEL) as Status[]).map((s) => [s, STATUS_LABEL[s]])}
        />
        <div className="flex gap-2 ml-auto">
          <button
            onClick={() => setSelected(new Set(approvable.slice(0, 100).map((v) => v.id)))}
            className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-300 hover:bg-gray-800"
          >
            Tout sélectionner ({Math.min(approvable.length, 100)})
          </button>
          <button
            onClick={bulkApprove}
            disabled={!selectedApprovable.length || busy !== null}
            className="rounded bg-green-800 px-3 py-1 text-sm text-white disabled:opacity-40"
          >
            Approuver la sélection ({selectedApprovable.length})
          </button>
        </div>
      </div>

      {(error || info) && (
        <div className="sticky top-2 z-20 space-y-2" role="status" aria-live="polite">
          {error && <div className="rounded border border-red-800 bg-red-950 p-3 text-sm text-red-300 shadow-lg">{error}</div>}
          {info && <div className="rounded border border-green-800 bg-green-950 p-3 text-sm text-green-300 shadow-lg">{info}</div>}
        </div>
      )}
      {loading && <div className="text-gray-400 text-sm">Chargement…</div>}
      {!loading && shown.length === 0 && !error && (
        <div className="rounded border border-gray-800 bg-gray-900 p-6 text-gray-400 text-sm">
          Aucune vidéo pour ces filtres.
        </div>
      )}

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {shown.map((v) => {
          const st = statusOf(v);
          const caption = drafts[v.id] ?? v.caption ?? "";
          const locked = st === "scheduled" || st === "published";
          return (
            <div key={v.id} className="rounded-lg border border-gray-800 bg-gray-900 p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`rounded border px-1.5 py-0.5 text-[11px] ${STATUS_CLASS[st]}`}>
                  {STATUS_LABEL[st]}
                  {st === "scheduled" && v.queue_scheduled_at ? ` · ${fmtWhen(v.queue_scheduled_at)}` : ""}
                </span>
                {v.qa_verdict && (
                  <span className={`rounded border px-1.5 py-0.5 text-[11px] ${QA_CLASS[v.qa_verdict]}`}>
                    {QA_LABEL[v.qa_verdict]}
                  </span>
                )}
                {v.lang && <span className="text-[11px] text-gray-400 uppercase">{v.lang}</span>}
                {st === "new" && v.lang && v.style && (
                  <input
                    type="checkbox"
                    checked={selected.has(v.id)}
                    onChange={() => toggle(v.id)}
                    className="ml-auto"
                    aria-label="Sélectionner"
                  />
                )}
              </div>
              <video
                src={v.video_url}
                controls
                preload="metadata"
                playsInline
                className="w-full aspect-[9/16] rounded bg-black object-contain"
              />
              <div className="text-sm text-gray-200">
                {styleLabel(v.style)}
                {v.label ? ` — ${v.label}` : v.sku ? ` — ${v.sku}` : ""}
              </div>
              <div className="text-xs text-gray-500">
                {[v.series, v.campaign, v.skus.length ? v.skus.join(", ") : null].filter(Boolean).join(" · ")}
              </div>
              {v.qa_notes && <div className="text-xs text-gray-400 whitespace-pre-line">{v.qa_notes}</div>}

              <textarea
                value={caption}
                onChange={(e) => setDrafts((d) => ({ ...d, [v.id]: e.target.value }))}
                onBlur={() => saveCaption(v)}
                disabled={locked || !v.lang}
                rows={5}
                placeholder="Légende"
                className="w-full rounded border border-gray-700 bg-gray-950 p-2 text-xs text-gray-200 disabled:opacity-60"
              />

              <div className="flex gap-2">
                {st === "new" || st === "rerender" || st === "rejected" ? (
                  <button
                    onClick={() => approve(v)}
                    disabled={busy !== null || !v.lang || !v.style || v.verdict === "bad"}
                    className="flex-1 rounded bg-green-800 px-2 py-1 text-sm text-white disabled:opacity-40"
                  >
                    {busy === v.id ? "Planification…" : "Approuver et planifier"}
                  </button>
                ) : st === "scheduled" ? (
                  <button
                    onClick={() => cancel(v)}
                    disabled={busy !== null}
                    className="flex-1 rounded border border-gray-600 px-2 py-1 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-40"
                  >
                    {busy === v.id ? "Retrait…" : "Retirer de l’horaire"}
                  </button>
                ) : null}
                {!locked && (
                  <button
                    onClick={() => saveVerdict(v.id, v.verdict === "bad" ? null : "bad")}
                    className={`rounded px-2 py-1 text-sm border ${
                      v.verdict === "bad"
                        ? "bg-red-950/60 border-red-800 text-red-200"
                        : "border-gray-700 text-gray-300 hover:bg-gray-800"
                    }`}
                    title="Rejeter (n'est jamais publiée)"
                  >
                    👎
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      </>
      )}
    </div>
  );
}
