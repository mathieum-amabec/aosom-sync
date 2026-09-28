"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";

/**
 * Studio Avant/Après — Mat builds before/after videos by hand:
 *   1. pick a product in the Aosom top sellers,
 *   2. pick the AVANT and APRÈS images (Shopify gallery, his own uploads, AI retouches),
 *   3. pick music + transition + format/duration/texts,
 *   4. render (on Vercel), preview, then send to the queue as a draft or download the MP4.
 */

interface TopProduct {
  rank: number;
  shopifyProductId: string;
  sku: string;
  skus: string[];
  title: string;
  productType: string;
  price: number;
  stock: number;
  velocity: number;
  thumbnail: string | null;
  imageCount: number;
  status: string;
  hasBeforeAfter: boolean;
}
interface GalleryImage { url: string; width: number | null; height: number | null; alt: string | null }
interface ExtraImage { id: number; url: string; source: "upload" | "ai"; parentUrl: string | null; prompt: string | null }
interface RenderJob {
  id: number;
  status: "rendering" | "ready" | "error";
  videoUrl: string | null;
  error: string | null;
  queueId: number | null;
  params?: { format: string; transition: string; durationSec: number };
}
interface Options {
  transitions: { id: string; label: string; description: string }[];
  formats: { id: string; label: string }[];
  durations: number[];
  tracks: { url: string; name: string; size: number }[];
  ai: {
    configured: boolean;
    tiers: { id: string; label: string; price: string; model: string }[];
    dailyCap: number;
    usedToday: number;
    presets: { id: string; label: string; description: string }[];
    scenes: string[];
    seasons: string[];
  };
}
type Fit = "contain" | "cover";
interface Pick { url: string; fit: Fit }

const INPUT =
  "w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
const CARD = "bg-gray-900 border border-gray-800 rounded-xl p-4";
const SCENE_LABELS: Record<string, string> = { salon: "Salon", chambre: "Chambre", patio: "Patio", jardin: "Jardin", cuisine: "Cuisine", bureau: "Bureau" };
const SEASON_LABELS: Record<string, string> = { halloween: "Halloween", noel: "Noël", automne: "Automne", ete: "Été" };
const CTA = { fr: "Livraison gratuite partout au Canada", en: "Free shipping across Canada" };

const money = (n: number) => `${n.toFixed(2).replace(".", ",")} $`;
const topCategory = (t: string) => t.split(">")[0].trim() || "Autre";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(json.error || `Erreur ${res.status}`);
  return json.data as T;
}

export default function StudioPage() {
  const [options, setOptions] = useState<Options | null>(null);
  const [top, setTop] = useState<TopProduct[] | null>(null);
  const [topError, setTopError] = useState<string | null>(null);
  const [days, setDays] = useState(14);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [hideDone, setHideDone] = useState(false);

  const [product, setProduct] = useState<TopProduct | null>(null);
  const [gallery, setGallery] = useState<GalleryImage[]>([]);
  const [extra, setExtra] = useState<ExtraImage[]>([]);
  const [history, setHistory] = useState<RenderJob[]>([]);
  const [loadingProduct, setLoadingProduct] = useState(false);
  const [productError, setProductError] = useState<string | null>(null);

  const [before, setBefore] = useState<Pick | null>(null);
  const [after, setAfter] = useState<Pick | null>(null);
  const [pickMode, setPickMode] = useState<"before" | "after">("before");

  const [aiTarget, setAiTarget] = useState<string | null>(null);
  const [aiPreset, setAiPreset] = useState("stage");
  const [aiScene, setAiScene] = useState("salon");
  const [aiSeason, setAiSeason] = useState("halloween");
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiTier, setAiTier] = useState("quality");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  const [track, setTrack] = useState<string>("");
  const [musicStart, setMusicStart] = useState(0);
  const [transition, setTransition] = useState("slider");
  const [duration, setDuration] = useState(10);
  const [formats, setFormats] = useState<string[]>(["9:16"]);
  const [locale, setLocale] = useState<"fr" | "en">("fr");
  const [labels, setLabels] = useState(true);
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [cta, setCta] = useState(CTA.fr);

  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const musicInput = useRef<HTMLInputElement>(null);

  const loadOptions = useCallback(() => {
    api<Options>("/api/studio/options").then(setOptions).catch((e) => setTopError(e.message));
  }, []);
  useEffect(loadOptions, [loadOptions]);

  useEffect(() => {
    api<{ products: TopProduct[] }>(`/api/studio/top?days=${days}`)
      .then((d) => setTop(d.products))
      .catch((e) => setTopError(e.message));
  }, [days]);

  const categories = useMemo(() => [...new Set((top ?? []).map((p) => topCategory(p.productType)))].sort(), [top]);
  const visible = useMemo(
    () =>
      (top ?? []).filter(
        (p) =>
          (!hideDone || !p.hasBeforeAfter) &&
          (!category || topCategory(p.productType) === category) &&
          (!search || `${p.title} ${p.skus.join(" ")}`.toLowerCase().includes(search.toLowerCase())),
      ),
    [top, hideDone, category, search],
  );

  const loadProduct = useCallback(async (p: TopProduct) => {
    setLoadingProduct(true);
    setProductError(null);
    try {
      const d = await api<{ title: string; images: GalleryImage[]; extraImages: ExtraImage[]; renders: RenderJob[] }>(
        `/api/studio/product/${p.shopifyProductId}?sku=${encodeURIComponent(p.sku)}`,
      );
      setGallery(d.images);
      setExtra(d.extraImages);
      setHistory(d.renders);
    } catch (e) {
      setProductError(e instanceof Error ? e.message : "Erreur");
    }
    setLoadingProduct(false);
  }, []);

  function selectProduct(p: TopProduct) {
    setProduct(p);
    setBefore(null);
    setAfter(null);
    setPickMode("before");
    setJobs([]);
    setAiTarget(null);
    setAiError(null);
    setTitle(p.title.length > 44 ? p.title.slice(0, 44).replace(/\s+\S*$/, "") : p.title);
    setPrice(money(p.price));
    void loadProduct(p);
  }

  function pickImage(url: string) {
    if (pickMode === "before") {
      setBefore({ url, fit: before?.fit ?? "contain" });
      if (!after) setPickMode("after");
    } else {
      setAfter({ url, fit: after?.fit ?? "cover" });
    }
  }

  async function uploadPhoto(file: File) {
    if (!product) return;
    setUploading("Téléversement de la photo…");
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const blob = await upload(`studio/uploads/${product.sku}/${safe}`, file, { access: "public", handleUploadUrl: "/api/studio/upload" });
      const img = await api<ExtraImage>("/api/studio/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: product.sku, url: blob.url }),
      });
      setExtra((x) => [img, ...x]);
    } catch (e) {
      setProductError(e instanceof Error ? e.message : "Téléversement impossible");
    }
    setUploading(null);
  }

  async function uploadTrack(file: File) {
    setUploading("Téléversement de la musique…");
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const blob = await upload(`studio/music/${safe}`, file, { access: "public", handleUploadUrl: "/api/studio/upload" });
      loadOptions();
      setTrack(blob.url);
    } catch (e) {
      setRenderError(e instanceof Error ? e.message : "Téléversement impossible");
    }
    setUploading(null);
  }

  async function deleteExtra(img: ExtraImage) {
    if (!confirm("Supprimer cette image du Studio ?")) return;
    try {
      await api(`/api/studio/images/${img.id}`, { method: "DELETE" });
      setExtra((x) => x.filter((e) => e.id !== img.id));
      if (before?.url === img.url) setBefore(null);
      if (after?.url === img.url) setAfter(null);
    } catch (e) {
      setProductError(e instanceof Error ? e.message : "Suppression impossible");
    }
  }

  async function runRetouch() {
    if (!product || !aiTarget) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const img = await api<ExtraImage>("/api/studio/retouch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku: product.sku,
          imageUrl: aiTarget,
          preset: aiPreset,
          scene: aiScene,
          season: aiSeason,
          instruction: aiInstruction,
          productTitle: product.title,
          tier: aiTier,
        }),
      });
      setExtra((x) => [img, ...x]);
      setOptions((o) => (o ? { ...o, ai: { ...o.ai, usedToday: o.ai.usedToday + 1 } } : o));
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "Retouche impossible");
    }
    setAiBusy(false);
  }

  async function startRender() {
    if (!product || !before || !after) return;
    setStarting(true);
    setRenderError(null);
    try {
      const created: RenderJob[] = [];
      for (const format of formats) {
        const d = await api<{ id: number }>("/api/studio/render", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sku: product.sku,
            shopifyProductId: product.shopifyProductId,
            productTitle: product.title,
            before,
            after,
            transition,
            durationSec: duration,
            format,
            locale,
            musicUrl: track || null,
            musicStartSec: musicStart,
            texts: { labels, title, price, cta },
          }),
        });
        created.push({ id: d.id, status: "rendering", videoUrl: null, error: null, queueId: null, params: { format, transition, durationSec: duration } });
      }
      setJobs((j) => [...created, ...j]);
    } catch (e) {
      setRenderError(e instanceof Error ? e.message : "Rendu impossible");
    }
    setStarting(false);
  }

  // Poll renders in progress.
  useEffect(() => {
    if (!jobs.some((j) => j.status === "rendering")) return;
    const t = setInterval(async () => {
      const updated = await Promise.all(
        jobs.map(async (j) => (j.status === "rendering" ? await api<RenderJob>(`/api/studio/render/${j.id}`).catch(() => j) : j)),
      );
      setJobs(updated);
    }, 3000);
    return () => clearInterval(t);
  }, [jobs]);

  async function sendToQueue(job: RenderJob) {
    try {
      const d = await api<{ queueId: number }>(`/api/studio/render/${job.id}/queue`, { method: "POST" });
      setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, queueId: d.queueId } : j)));
      setHistory((hs) => hs.map((h) => (h.id === job.id ? { ...h, queueId: d.queueId } : h)));
    } catch (e) {
      setRenderError(e instanceof Error ? e.message : "Ajout à la file impossible");
    }
  }

  const allImages: { url: string; badge?: string; extra?: ExtraImage }[] = [
    ...extra.map((e) => ({ url: e.url, badge: e.source === "ai" ? "IA" : "Ma photo", extra: e })),
    ...gallery.map((g) => ({ url: g.url })),
  ];
  const canRender = !!product && !!before && !!after && formats.length > 0 && !starting;
  const aiLeft = options ? Math.max(0, options.ai.dailyCap - options.ai.usedToday) : 0;

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-white">Studio Avant/Après</h2>
        <p className="text-gray-400 text-sm mt-0.5">
          Choisis un produit, l&apos;image avant, l&apos;image après, la musique et la transition — la vidéo se crée en ~1 minute.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[380px_1fr] gap-6">
        {/* ── 1. Top sellers ─────────────────────────────── */}
        <section className={`${CARD} xl:max-h-[calc(100vh-10rem)] xl:overflow-y-auto`}>
          <h3 className="text-white font-semibold mb-1">1. Produit — top ventes Aosom</h3>
          <p className="text-[11px] text-gray-500 mb-3">
            Unités sorties du stock Aosom (tous revendeurs), pas tes ventes Shopify.
          </p>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <select
              value={days}
              onChange={(e) => {
                setTop(null);
                setTopError(null);
                setDays(Number(e.target.value));
              }}
              className={INPUT}
            >
              <option value={7}>7 jours</option>
              <option value={14}>14 jours</option>
              <option value={30}>30 jours</option>
            </select>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={INPUT}>
              <option value="">Toutes catégories</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <input type="search" placeholder="Chercher…" value={search} onChange={(e) => setSearch(e.target.value)} className={`${INPUT} mb-2`} />
          <label className="flex items-center gap-2 text-sm text-gray-400 mb-3">
            <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
            Cacher ceux qui ont déjà une vidéo avant/après
          </label>
          {topError && <p className="text-red-400 text-sm">{topError}</p>}
          {!top && !topError && <p className="text-gray-500 text-sm">Chargement du top…</p>}
          <ul className="space-y-1">
            {visible.map((p) => (
              <li key={p.shopifyProductId}>
                <button
                  onClick={() => selectProduct(p)}
                  className={`w-full flex items-center gap-3 p-2 rounded-lg text-left transition-colors ${
                    product?.shopifyProductId === p.shopifyProductId ? "bg-blue-600/20 border border-blue-600/50" : "hover:bg-gray-800/60 border border-transparent"
                  }`}
                >
                  <span className="text-gray-500 text-xs w-6 text-right shrink-0">#{p.rank}</span>
                  {p.thumbnail ? (
                    <img src={p.thumbnail} alt="" className="w-12 h-12 object-cover rounded bg-gray-800 shrink-0" loading="lazy" />
                  ) : (
                    <div className="w-12 h-12 rounded bg-gray-800 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-white line-clamp-2">{p.title}</span>
                    <span className="block text-[11px] text-gray-500">
                      {p.velocity} vendus · {p.imageCount} images · {money(p.price)}
                      {p.stock <= 0 && <span className="text-amber-400"> · rupture</span>}
                      {p.status !== "ACTIVE" && <span className="text-amber-400"> · {p.status.toLowerCase()}</span>}
                    </span>
                  </span>
                  {p.hasBeforeAfter && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/40 text-green-400 shrink-0">déjà fait</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* ── Workspace ─────────────────────────────────── */}
        <div className="space-y-6 min-w-0">
          {!product && <div className={`${CARD} text-gray-500 text-center py-16`}>← Choisis un produit dans le top pour commencer.</div>}

          {product && (
            <>
              {/* ── 2. Images ─────────────────────────── */}
              <section className={CARD}>
                <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                  <h3 className="text-white font-semibold">2. Images — {product.title}</h3>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setPickMode("before")}
                      className={`px-3 py-1.5 rounded-lg text-sm border ${pickMode === "before" ? "bg-amber-500/20 border-amber-500 text-amber-300" : "border-gray-700 text-gray-400"}`}
                    >
                      Je choisis l&apos;AVANT
                    </button>
                    <button
                      onClick={() => setPickMode("after")}
                      className={`px-3 py-1.5 rounded-lg text-sm border ${pickMode === "after" ? "bg-green-500/20 border-green-500 text-green-300" : "border-gray-700 text-gray-400"}`}
                    >
                      Je choisis l&apos;APRÈS
                    </button>
                    <button onClick={() => photoInput.current?.click()} className="px-3 py-1.5 rounded-lg text-sm border border-gray-700 text-gray-300 hover:text-white">
                      + Ma photo
                    </button>
                    <input
                      ref={photoInput}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void uploadPhoto(f);
                        e.target.value = "";
                      }}
                    />
                  </div>
                </div>
                <p className="text-[11px] text-gray-500 mb-3">
                  Clique une image pour l&apos;assigner. Styles possibles : fond blanc → lifestyle, deux états du produit (fermé → ouvert),
                  ta propre photo « avant », ou une pièce vide créée par l&apos;IA (retouche « Pièce vide » sur la photo lifestyle).
                </p>
                {uploading && <p className="text-blue-300 text-sm mb-2">{uploading}</p>}
                {productError && <p className="text-red-400 text-sm mb-2">{productError}</p>}
                {loadingProduct && <p className="text-gray-500 text-sm">Chargement des images…</p>}

                {/* Current picks */}
                <div className="grid grid-cols-2 gap-3 mb-4">
                  {([["AVANT", before, setBefore, "amber"], ["APRÈS", after, setAfter, "green"]] as const).map(([label, pick, setPick, color]) => (
                    <div key={label} className={`rounded-lg border p-2 ${color === "amber" ? "border-amber-600/50" : "border-green-600/50"}`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className={`text-xs font-bold ${color === "amber" ? "text-amber-300" : "text-green-300"}`}>{label}</span>
                        {pick && (
                          <select
                            value={pick.fit}
                            onChange={(e) => setPick({ ...pick, fit: e.target.value as Fit })}
                            className="text-xs bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-gray-300"
                          >
                            <option value="contain">Entière (fond flou)</option>
                            <option value="cover">Plein écran (recadrée)</option>
                          </select>
                        )}
                      </div>
                      {pick ? (
                        <img src={pick.url} alt={label} className="w-full aspect-[9/16] max-h-72 object-contain bg-gray-950 rounded" />
                      ) : (
                        <div className="w-full aspect-[9/16] max-h-72 rounded bg-gray-950 flex items-center justify-center text-gray-600 text-sm">à choisir</div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Gallery */}
                <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                  {allImages.map((im) => {
                    const isBefore = before?.url === im.url;
                    const isAfter = after?.url === im.url;
                    return (
                      <div key={im.url} className="relative group">
                        <button
                          onClick={() => pickImage(im.url)}
                          className={`block w-full aspect-square rounded-lg overflow-hidden border-2 ${
                            isBefore ? "border-amber-400" : isAfter ? "border-green-400" : "border-transparent hover:border-gray-600"
                          }`}
                          title={im.extra?.prompt ?? "Choisir"}
                        >
                          <img src={im.url} alt="" className="w-full h-full object-cover bg-gray-800" loading="lazy" />
                        </button>
                        {im.badge && (
                          <span className={`absolute top-1 left-1 text-[10px] px-1.5 py-0.5 rounded ${im.badge === "IA" ? "bg-purple-600 text-white" : "bg-gray-700 text-gray-200"}`}>
                            {im.badge}
                          </span>
                        )}
                        {(isBefore || isAfter) && (
                          <span className={`absolute bottom-1 left-1 text-[10px] px-1.5 py-0.5 rounded font-bold ${isBefore ? "bg-amber-500 text-black" : "bg-green-500 text-black"}`}>
                            {isBefore ? "AVANT" : "APRÈS"}
                          </span>
                        )}
                        <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                          <button
                            onClick={() => setAiTarget(im.url)}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-purple-700 text-white"
                            title="Retoucher avec l'IA"
                          >
                            IA
                          </button>
                          {im.extra && (
                            <button onClick={() => deleteExtra(im.extra!)} className="text-[10px] px-1.5 py-0.5 rounded bg-red-800 text-white" title="Supprimer">
                              ✕
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* ── AI retouch panel ───────────────────── */}
              {aiTarget && (
                <section className={`${CARD} border-purple-800/60`}>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-white font-semibold">Retouche IA</h3>
                    <button onClick={() => setAiTarget(null)} className="text-gray-400 hover:text-white text-sm">Fermer</button>
                  </div>
                  {!options?.ai.configured ? (
                    <p className="text-amber-300 text-sm">
                      La retouche IA n&apos;est pas encore activée : il faut ajouter <code>AI_GATEWAY_API_KEY</code> dans les variables
                      d&apos;environnement Vercel (et du crédit AI Gateway).
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-4">
                      <img src={aiTarget} alt="Image à retoucher" className="w-full rounded bg-gray-800" />
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {options.ai.presets.map((p) => (
                            <button
                              key={p.id}
                              onClick={() => setAiPreset(p.id)}
                              title={p.description}
                              className={`px-2 py-2 rounded-lg text-sm border text-left ${aiPreset === p.id ? "border-purple-500 bg-purple-600/20 text-purple-200" : "border-gray-700 text-gray-300"}`}
                            >
                              <span className="block font-medium">{p.label}</span>
                              <span className="block text-[11px] text-gray-500">{p.description}</span>
                            </button>
                          ))}
                        </div>
                        {aiPreset === "stage" && (
                          <select value={aiScene} onChange={(e) => setAiScene(e.target.value)} className={INPUT}>
                            {options.ai.scenes.map((s) => (
                              <option key={s} value={s}>{SCENE_LABELS[s] ?? s}</option>
                            ))}
                          </select>
                        )}
                        {aiPreset === "season" && (
                          <select value={aiSeason} onChange={(e) => setAiSeason(e.target.value)} className={INPUT}>
                            {options.ai.seasons.map((s) => (
                              <option key={s} value={s}>{SEASON_LABELS[s] ?? s}</option>
                            ))}
                          </select>
                        )}
                        {aiPreset === "free" && (
                          <textarea
                            value={aiInstruction}
                            onChange={(e) => setAiInstruction(e.target.value)}
                            rows={3}
                            placeholder="Ex. : mets le sofa dans un salon scandinave lumineux avec un tapis beige"
                            className={INPUT}
                          />
                        )}
                        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Modèle IA">
                          {options.ai.tiers.map((t) => (
                            <button
                              key={t.id}
                              role="radio"
                              aria-checked={aiTier === t.id}
                              onClick={() => setAiTier(t.id)}
                              title={t.model}
                              className={`px-3 py-1.5 rounded-lg text-sm border ${aiTier === t.id ? "border-purple-500 bg-purple-600/20 text-purple-200" : "border-gray-700 text-gray-400"}`}
                            >
                              {t.label} <span className="text-[11px] text-gray-500">{t.price}</span>
                            </button>
                          ))}
                        </div>
                        <p className="text-[11px] text-gray-500">
                          Le produit doit rester identique — seul le décor change. Compare toujours avec l&apos;original avant d&apos;utiliser l&apos;image.
                          Retouches restantes aujourd&apos;hui : {aiLeft}/{options.ai.dailyCap}.
                        </p>
                        <button
                          onClick={runRetouch}
                          disabled={aiBusy || aiLeft <= 0}
                          className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-purple-900 disabled:text-purple-300 text-white text-sm font-medium rounded-lg"
                        >
                          {aiBusy ? "Retouche en cours… (20-60 s)" : "Lancer la retouche"}
                        </button>
                        {aiError && <p className="text-red-400 text-sm">{aiError}</p>}
                      </div>
                    </div>
                  )}
                </section>
              )}

              {/* ── 3. Music & transition ──────────────── */}
              <section className={CARD}>
                <h3 className="text-white font-semibold mb-3">3. Musique et transition</h3>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-gray-300">Musique</span>
                      <button onClick={() => musicInput.current?.click()} className="text-xs text-blue-400 hover:text-blue-300">+ Ajouter une piste</button>
                      <input
                        ref={musicInput}
                        type="file"
                        accept="audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,audio/wav"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void uploadTrack(f);
                          e.target.value = "";
                        }}
                      />
                    </div>
                    <ul className="space-y-1 max-h-72 overflow-y-auto pr-1">
                      <li>
                        <label className="flex items-center gap-2 text-sm text-gray-400 p-1">
                          <input type="radio" name="track" checked={!track} onChange={() => setTrack("")} />
                          Sans musique
                        </label>
                      </li>
                      {options?.tracks.map((t) => (
                        <li key={t.url} className={`p-1 rounded ${track === t.url ? "bg-blue-600/10" : ""}`}>
                          <label className="flex items-center gap-2 text-sm text-gray-200">
                            <input type="radio" name="track" checked={track === t.url} onChange={() => setTrack(t.url)} />
                            {t.name}
                          </label>
                          {track === t.url && <audio src={t.url} controls preload="none" className="w-full h-8 mt-1" />}
                        </li>
                      ))}
                      {options && options.tracks.length === 0 && <li className="text-xs text-amber-300 p-1">Aucune piste en ligne — ajoute-en une.</li>}
                    </ul>
                    {track && (
                      <label className="block text-xs text-gray-400 mt-2">
                        Commencer la musique à {musicStart} s
                        <input type="range" min={0} max={120} step={1} value={musicStart} onChange={(e) => setMusicStart(Number(e.target.value))} className="w-full" />
                      </label>
                    )}
                  </div>
                  <div>
                    <span className="text-sm text-gray-300 block mb-2">Transition</span>
                    <div className="grid grid-cols-2 gap-2">
                      {options?.transitions.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => setTransition(t.id)}
                          className={`px-2 py-2 rounded-lg text-left border ${transition === t.id ? "border-blue-500 bg-blue-600/15" : "border-gray-700 hover:border-gray-600"}`}
                        >
                          <span className="block text-sm text-white">
                            {t.label}
                            {t.id === "slider" && <span className="ml-1 text-[10px] text-amber-300">★ recommandé</span>}
                          </span>
                          <span className="block text-[11px] text-gray-500">{t.description}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              {/* ── 4. Options & render ────────────────── */}
              <section className={CARD}>
                <h3 className="text-white font-semibold mb-3">4. Format, textes et création</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                  <div>
                    <span className="text-sm text-gray-300 block mb-1">Format</span>
                    {options?.formats.map((f) => (
                      <label key={f.id} className="flex items-center gap-2 text-sm text-gray-300">
                        <input
                          type="checkbox"
                          checked={formats.includes(f.id)}
                          onChange={(e) => setFormats((fs) => (e.target.checked ? [...fs, f.id] : fs.filter((x) => x !== f.id)))}
                        />
                        {f.label}
                      </label>
                    ))}
                  </div>
                  <div>
                    <span className="text-sm text-gray-300 block mb-1">Durée</span>
                    <div className="flex gap-2">
                      {options?.durations.map((d) => (
                        <button
                          key={d}
                          onClick={() => setDuration(d)}
                          className={`px-3 py-1.5 rounded-lg text-sm border ${duration === d ? "border-blue-500 bg-blue-600/15 text-white" : "border-gray-700 text-gray-400"}`}
                        >
                          {d} s
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="text-sm text-gray-300 block mb-1">Langue</span>
                    <div className="flex gap-2">
                      {(["fr", "en"] as const).map((l) => (
                        <button
                          key={l}
                          onClick={() => {
                            setLocale(l);
                            setCta((c) => (c === CTA.fr || c === CTA.en ? CTA[l] : c));
                          }}
                          className={`px-3 py-1.5 rounded-lg text-sm border ${locale === l ? "border-blue-500 bg-blue-600/15 text-white" : "border-gray-700 text-gray-400"}`}
                        >
                          {l === "fr" ? "Français" : "English"}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                  <label className="text-xs text-gray-400">
                    Titre en haut (vide = aucun)
                    <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} className={INPUT} />
                  </label>
                  <label className="text-xs text-gray-400">
                    Prix (vide = aucun)
                    <input value={price} onChange={(e) => setPrice(e.target.value)} maxLength={24} className={INPUT} />
                  </label>
                  <label className="text-xs text-gray-400">
                    Bandeau doré (vide = aucun)
                    <input value={cta} onChange={(e) => setCta(e.target.value)} maxLength={48} className={INPUT} />
                  </label>
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-300 mb-4">
                  <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} />
                  Afficher les étiquettes {locale === "fr" ? "AVANT / APRÈS" : "BEFORE / AFTER"}
                </label>
                <button
                  onClick={startRender}
                  disabled={!canRender}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-500 text-white font-medium rounded-lg"
                >
                  {starting ? "Démarrage…" : `Créer la vidéo${formats.length > 1 ? "s" : ""}`}
                </button>
                {!before || !after ? <span className="ml-3 text-xs text-gray-500">Choisis d&apos;abord l&apos;avant et l&apos;après.</span> : null}
                {renderError && <p className="text-red-400 text-sm mt-2">{renderError}</p>}
              </section>

              {/* ── Results ───────────────────────────── */}
              {(jobs.length > 0 || history.length > 0) && (
                <section className={CARD}>
                  <h3 className="text-white font-semibold mb-3">Vidéos</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {[...jobs, ...history.filter((h) => !jobs.some((j) => j.id === h.id))].map((j) => (
                      <div key={j.id} className="rounded-lg border border-gray-800 p-2">
                        <div className="text-[11px] text-gray-500 mb-1">
                          #{j.id} · {j.params?.format} · {j.params?.durationSec} s · {options?.transitions.find((t) => t.id === j.params?.transition)?.label ?? j.params?.transition}
                        </div>
                        {j.status === "rendering" && <div className="aspect-[9/16] max-h-80 flex items-center justify-center text-blue-300 text-sm bg-gray-950 rounded">Création en cours…</div>}
                        {j.status === "error" && <div className="text-red-400 text-sm p-2">{j.error ?? "Échec du rendu"}</div>}
                        {j.status === "ready" && j.videoUrl && (
                          <>
                            <video src={j.videoUrl} controls playsInline className="w-full max-h-96 rounded bg-black" />
                            <div className="flex flex-wrap gap-2 mt-2">
                              {j.queueId ? (
                                <span className="text-xs px-2 py-1 rounded bg-green-900/40 text-green-400">En brouillon (file #{j.queueId}) — à approuver dans Formats de contenu</span>
                              ) : (
                                <button onClick={() => sendToQueue(j)} className="text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white">
                                  Envoyer en brouillon
                                </button>
                              )}
                              <a href={j.videoUrl} download target="_blank" rel="noopener noreferrer" className="text-xs px-2 py-1 rounded border border-gray-700 text-gray-300 hover:text-white">
                                Télécharger le MP4 (pubs)
                              </a>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
