"use client";

import { useState, useEffect, useCallback } from "react";

interface ChannelState {
  status: "pending" | "published" | "error" | "skipped";
  publishedId?: string;
  publishedAt?: number;
  error?: string;
}

interface Draft {
  id: number;
  sku: string;
  triggerType: string;
  language: string;
  postText: string;
  postTextEn: string | null;
  imagePath: string | null;
  imageUrl: string | null;
  imageUrls: string[];
  oldPrice: number | null;
  newPrice: number | null;
  status: string;
  scheduledAt: number | null;
  publishedAt: number | null;
  facebookPostId: string | null;
  channels: Record<string, ChannelState>;
  createdAt: number;
  productName?: string;
  productImage?: string;
}

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-gray-700/50 text-gray-300 border-gray-600",
  approved: "bg-green-900/40 text-green-400 border-green-800/50",
  scheduled: "bg-blue-900/40 text-blue-400 border-blue-800/50",
  published: "bg-purple-900/40 text-purple-400 border-purple-800/50",
  rejected: "bg-red-900/40 text-red-400 border-red-800/50",
};

const TRIGGER_LABELS: Record<string, string> = {
  new_product: "New Product",
  price_drop: "Price Drop",
  stock_highlight: "Highlight",
};

const CHANNEL_LABELS: Record<string, { short: string; long: string; lang: "FR" | "EN"; platform: "fb" | "ig" }> = {
  fb_ameublo: { short: "FB Ameublo", long: "Facebook Ameublo Direct (FR)", lang: "FR", platform: "fb" },
  fb_furnish: { short: "FB Furnish", long: "Facebook Furnish Direct (EN)", lang: "EN", platform: "fb" },
  ig_ameublo: { short: "IG Ameublo", long: "Instagram Ameublo Direct (FR)", lang: "FR", platform: "ig" },
  ig_furnish: { short: "IG Furnish", long: "Instagram Furnish Direct (EN)", lang: "EN", platform: "ig" },
};

const DEFAULT_CHANNELS: string[] = ["fb_ameublo", "fb_furnish", "ig_ameublo"];

function isPublished(draft: Draft): boolean {
  return draft.status === "published";
}

function formatPublishedAt(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("fr-CA", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ChannelBadge({ channelKey, state }: { channelKey: string; state: ChannelState }) {
  const label = CHANNEL_LABELS[channelKey]?.short || channelKey;
  const color =
    state.status === "published"
      ? "bg-green-900/40 text-green-400 border-green-800/50"
      : state.status === "error"
      ? "bg-red-900/40 text-red-400 border-red-800/50"
      : "bg-gray-800 text-gray-400 border-gray-700";
  return (
    <span
      title={state.error || state.publishedId || ""}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium border ${color}`}
    >
      {state.status === "published" ? "✓ " : state.status === "error" ? "✗ " : ""}
      {label}
    </span>
  );
}

export default function SocialPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [activeChannels, setActiveChannels] = useState<string[]>(DEFAULT_CHANNELS);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [generating, setGenerating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTextFr, setEditTextFr] = useState("");
  const [editTextEn, setEditTextEn] = useState("");
  const [editTab, setEditTab] = useState<"fr" | "en">("fr");
  const [scheduleId, setScheduleId] = useState<number | null>(null);
  const [scheduleDate, setScheduleDate] = useState("");
  const [publishId, setPublishId] = useState<number | null>(null);
  const [publishChannels, setPublishChannels] = useState<Set<string>>(new Set(DEFAULT_CHANNELS));
  const [publishing, setPublishing] = useState(false);
  const [photoEditId, setPhotoEditId] = useState<number | null>(null);
  const [photoEditUrls, setPhotoEditUrls] = useState<string[]>([]);
  const [view, setView] = useState<"list" | "calendar">("list");
  const [previewLang, setPreviewLang] = useState<Record<number, "FR" | "EN">>({});

  const fetchDrafts = useCallback(async () => {
    const params = filter !== "all" ? `?status=${filter}` : "";
    const res = await fetch(`/api/social${params}`);
    const data = await res.json();
    if (data.success) {
      setDrafts(data.data);
      if (Array.isArray(data.activeChannels)) setActiveChannels(data.activeChannels);
    }
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const params = filter !== "all" ? `?status=${filter}` : "";
      const res = await fetch(`/api/social${params}`);
      const data = await res.json();
      if (cancelled) return;
      if (data.success) {
        setDrafts(data.data);
        if (Array.isArray(data.activeChannels)) setActiveChannels(data.activeChannels);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [filter]);

  async function doAction(action: string, id: number, extra?: Record<string, unknown>) {
    const res = await fetch("/api/social", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, id, ...extra }),
    });
    const data = await res.json();
    if (!data.success && data.error) alert(`Error: ${data.error}`);
    fetchDrafts();
    return data;
  }

  async function generateHighlight() {
    setGenerating(true);
    await fetch("/api/social", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "generate", triggerType: "stock_highlight" }),
    });
    setGenerating(false);
    fetchDrafts();
  }

  function saveEdit(id: number) {
    doAction("update", id, { postText: editTextFr, postTextEn: editTextEn });
    setEditingId(null);
  }

  function savePhotoEdit(id: number) {
    doAction("update", id, { imageUrls: photoEditUrls });
    setPhotoEditId(null);
  }

  function removePhoto(idx: number) {
    setPhotoEditUrls(photoEditUrls.filter((_, i) => i !== idx));
  }

  function movePhoto(idx: number, direction: -1 | 1) {
    const next = [...photoEditUrls];
    const target = idx + direction;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setPhotoEditUrls(next);
  }

  function saveSchedule(id: number) {
    const ts = Math.floor(new Date(scheduleDate).getTime() / 1000);
    doAction("schedule", id, { scheduledAt: ts });
    setScheduleId(null);
  }

  async function doPublishMulti(id: number) {
    if (publishChannels.size === 0) {
      alert("Pick at least one channel");
      return;
    }
    setPublishing(true);
    const res = await fetch("/api/social", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "publish-multi", id, channels: Array.from(publishChannels) }),
    });
    const data = await res.json();
    setPublishing(false);
    setPublishId(null);
    fetchDrafts();

    if (data.results) {
      const ok = data.results.filter((r: { status: string }) => r.status === "published").length;
      const fail = data.results.filter((r: { status: string }) => r.status === "error").length;
      if (fail > 0) {
        const errMsg = data.results
          .filter((r: { status: string }) => r.status === "error")
          .map((r: { channel: string; error?: string }) => `${r.channel}: ${r.error}`)
          .join("\n");
        alert(`Published ${ok} / Failed ${fail}\n\n${errMsg}`);
      } else {
        alert(`Published to all ${ok} channel(s) successfully.`);
      }
    }
  }

  async function retryChannel(id: number, channel: string) {
    await doAction("retry-channel", id, { channel });
  }

  const stats = {
    total: drafts.length,
    draft: drafts.filter((d) => d.status === "draft").length,
    approved: drafts.filter((d) => d.status === "approved").length,
    scheduled: drafts.filter((d) => d.status === "scheduled").length,
    published: drafts.filter((d) => d.status === "published").length,
  };

  const calendarDrafts = drafts.filter((d) => d.scheduledAt || d.publishedAt);

  return (
    <div className="p-4 md:p-8 max-w-6xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Social Media</h2>
          <p className="text-gray-400 text-sm mt-1">
            Multi-channel publishing — {activeChannels.length} channels active
          </p>
        </div>
        <button
          onClick={generateHighlight}
          disabled={generating}
          className="w-full sm:w-auto px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-500 disabled:opacity-50 transition-colors"
        >
          {generating ? "Generating..." : "Generate Highlight"}
        </button>
      </div>

      <div className="grid grid-cols-3 md:grid-cols-5 gap-2 md:gap-3 mb-6">
        {[
          { label: "Total", value: stats.total, color: "text-white" },
          { label: "Drafts", value: stats.draft, color: "text-gray-400" },
          { label: "Approved", value: stats.approved, color: "text-green-400" },
          { label: "Scheduled", value: stats.scheduled, color: "text-blue-400" },
          { label: "Published", value: stats.published, color: "text-purple-400" },
        ].map((s) => (
          <div key={s.label} className="p-2 md:p-3 bg-gray-900 border border-gray-800 rounded-xl text-center">
            <p className={`text-lg md:text-xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-[10px] md:text-xs text-gray-500 mt-1">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div className="flex gap-2 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap">
          {["all", "draft", "approved", "scheduled", "published", "rejected"].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`shrink-0 px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                filter === f ? "bg-blue-600/20 border-blue-600 text-blue-400" : "border-gray-700 text-gray-400 hover:text-white"
              }`}
            >
              {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-gray-900 rounded-lg p-0.5 border border-gray-800">
          <button onClick={() => setView("list")} className={`px-3 py-1 text-xs rounded-md ${view === "list" ? "bg-gray-700 text-white" : "text-gray-500"}`}>
            List
          </button>
          <button onClick={() => setView("calendar")} className={`px-3 py-1 text-xs rounded-md ${view === "calendar" ? "bg-gray-700 text-white" : "text-gray-500"}`}>
            Calendar
          </button>
        </div>
      </div>

      {loading ? (
        <div className="p-8 text-center text-gray-500">Loading...</div>
      ) : view === "list" ? (
        drafts.length === 0 ? (
          <div className="p-8 bg-gray-900 border border-gray-800 rounded-xl text-center">
            <p className="text-gray-500 text-sm">No drafts yet</p>
            <p className="text-gray-600 text-xs mt-1">Import products or run a sync to trigger draft generation</p>
          </div>
        ) : (
          <div className="space-y-3">
            {drafts.map((draft) => {
              const lang = previewLang[draft.id] || "FR";
              const previewText = lang === "FR" ? draft.postText : draft.postTextEn || draft.postText;
              const hasEn = !!draft.postTextEn;
              const failedChannels = Object.entries(draft.channels || {}).filter(([, s]) => s.status === "error");
              // Pick browser-loadable thumbnails. draft.imagePath on Vercel is an absolute serverless filesystem
              // path ("/tmp/social-images/...") used only for binary upload, not rendering — skip those.
              // Otherwise use draft.imageUrls (multi-photo array) → fallback to legacy imageUrl/productImage.
              const galleryUrls: string[] =
                draft.imageUrls && draft.imageUrls.length > 0
                  ? draft.imageUrls
                  : draft.imageUrl
                  ? [draft.imageUrl]
                  : draft.productImage
                  ? [draft.productImage]
                  : [];
              const composedThumb =
                draft.imagePath && !draft.imagePath.startsWith("/tmp/") ? draft.imagePath : null;
              const heroSrc = composedThumb || galleryUrls[0] || null;
              const photoCount = galleryUrls.length;

              return (
                <div key={draft.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <div className="flex flex-col md:flex-row gap-4">
                    <div className="shrink-0 md:w-32">
                      <div className="relative">
                        {heroSrc ? (
                          <img src={heroSrc} alt="" className="w-full h-40 md:h-[67px] rounded-lg object-cover bg-gray-800" />
                        ) : (
                          <div className="w-full h-40 md:h-[67px] rounded-lg bg-gray-800 flex items-center justify-center text-gray-600 text-xs">
                            No image
                          </div>
                        )}
                        {photoCount >= 2 && (
                          <span className="absolute top-1 right-1 px-1.5 py-0.5 rounded-md bg-black/70 text-white text-[10px] font-medium">
                            {photoCount} photos
                          </span>
                        )}
                      </div>
                      {photoCount >= 2 && !composedThumb && (
                        <div className="mt-1 grid grid-cols-4 gap-1">
                          {galleryUrls.slice(1, 5).map((u, i) => (
                            <img
                              key={i}
                              src={u}
                              alt=""
                              className="w-full aspect-square rounded object-cover bg-gray-800"
                            />
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium border ${STATUS_STYLES[draft.status] || STATUS_STYLES.draft}`}>
                          {draft.status}
                        </span>
                        <span className="px-2 py-0.5 bg-gray-800 text-gray-400 rounded-md text-xs">
                          {TRIGGER_LABELS[draft.triggerType] || draft.triggerType}
                        </span>
                        <span className="text-xs text-gray-600">{draft.sku}</span>
                        {isPublished(draft) && draft.publishedAt && (
                          <span className="text-xs text-purple-300">
                            · Publié le {formatPublishedAt(draft.publishedAt)}
                          </span>
                        )}

                        {hasEn && (
                          <div className="ml-auto flex gap-1 bg-gray-800 rounded-md p-0.5">
                            <button
                              onClick={() => setPreviewLang({ ...previewLang, [draft.id]: "FR" })}
                              className={`px-2 py-0.5 text-[10px] rounded ${lang === "FR" ? "bg-gray-700 text-white" : "text-gray-500"}`}
                            >
                              FR
                            </button>
                            <button
                              onClick={() => setPreviewLang({ ...previewLang, [draft.id]: "EN" })}
                              className={`px-2 py-0.5 text-[10px] rounded ${lang === "EN" ? "bg-gray-700 text-white" : "text-gray-500"}`}
                            >
                              EN
                            </button>
                          </div>
                        )}
                      </div>

                      {draft.productName && (
                        <p className="text-sm text-gray-300 font-medium truncate mb-1">{draft.productName}</p>
                      )}

                      {editingId === draft.id ? (
                        <div className="mt-2">
                          <div className="flex gap-1 mb-2 bg-gray-800 rounded-md p-0.5 w-fit">
                            <button
                              onClick={() => setEditTab("fr")}
                              className={`px-2 py-0.5 text-[10px] rounded ${editTab === "fr" ? "bg-gray-700 text-white" : "text-gray-500"}`}
                            >
                              FR
                            </button>
                            <button
                              onClick={() => setEditTab("en")}
                              className={`px-2 py-0.5 text-[10px] rounded ${editTab === "en" ? "bg-gray-700 text-white" : "text-gray-500"}`}
                            >
                              EN
                            </button>
                          </div>
                          <textarea
                            value={editTab === "fr" ? editTextFr : editTextEn}
                            onChange={(e) =>
                              editTab === "fr" ? setEditTextFr(e.target.value) : setEditTextEn(e.target.value)
                            }
                            className="w-full bg-gray-800 border border-gray-700 rounded-lg p-2 text-sm text-gray-300 resize-y"
                            rows={4}
                          />
                          <div className="flex gap-2 mt-2">
                            <button onClick={() => saveEdit(draft.id)} className="px-3 py-1 bg-blue-600 text-white text-xs rounded-lg">
                              Save
                            </button>
                            <button onClick={() => setEditingId(null)} className="px-3 py-1 bg-gray-700 text-gray-300 text-xs rounded-lg">
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm text-gray-400 line-clamp-2 whitespace-pre-wrap">{previewText}</p>
                      )}

                      {photoEditId === draft.id && (
                        <div className="mt-3 p-3 bg-gray-950 border border-gray-800 rounded-lg">
                          <p className="text-xs text-gray-400 mb-2">Photos ({photoEditUrls.length}) — réordonner ou retirer</p>
                          {photoEditUrls.length === 0 ? (
                            <p className="text-xs text-gray-600">Aucune photo. Sauvegarder pour publier en texte seul.</p>
                          ) : (
                            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                              {photoEditUrls.map((url, i) => (
                                <div key={`${url}-${i}`} className="relative group">
                                  <img src={url} alt="" className="w-full aspect-square rounded object-cover bg-gray-800" />
                                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded flex flex-col items-center justify-center gap-1">
                                    <div className="flex gap-1">
                                      <button
                                        onClick={() => movePhoto(i, -1)}
                                        disabled={i === 0}
                                        className="px-1.5 py-0.5 text-[10px] bg-gray-800 text-white rounded disabled:opacity-30"
                                        title="Monter"
                                      >
                                        ←
                                      </button>
                                      <button
                                        onClick={() => movePhoto(i, 1)}
                                        disabled={i === photoEditUrls.length - 1}
                                        className="px-1.5 py-0.5 text-[10px] bg-gray-800 text-white rounded disabled:opacity-30"
                                        title="Descendre"
                                      >
                                        →
                                      </button>
                                    </div>
                                    <button
                                      onClick={() => removePhoto(i)}
                                      className="px-1.5 py-0.5 text-[10px] bg-red-600 text-white rounded"
                                      title="Retirer"
                                    >
                                      Retirer
                                    </button>
                                  </div>
                                  <span className="absolute top-0.5 left-0.5 px-1 bg-black/70 text-white text-[9px] rounded">
                                    {i + 1}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                          <div className="flex gap-2 mt-3">
                            <button onClick={() => savePhotoEdit(draft.id)} className="px-3 py-1 bg-blue-600 text-white text-xs rounded-lg">
                              Save
                            </button>
                            <button onClick={() => setPhotoEditId(null)} className="px-3 py-1 bg-gray-700 text-gray-300 text-xs rounded-lg">
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {draft.oldPrice && draft.newPrice && (
                        <p className="text-xs text-gray-500 mt-1">
                          <span className="line-through text-red-400">{draft.oldPrice.toFixed(2)}$</span>
                          {" → "}
                          <span className="text-green-400 font-medium">{draft.newPrice.toFixed(2)}$</span>
                        </p>
                      )}

                      {/* Per-channel state badges */}
                      {Object.keys(draft.channels || {}).length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {Object.entries(draft.channels).map(([k, s]) => (
                            <div key={k} className="flex items-center gap-1">
                              <ChannelBadge channelKey={k} state={s} />
                              {s.status === "error" && (
                                <button
                                  onClick={() => retryChannel(draft.id, k)}
                                  className="text-[10px] text-blue-400 hover:text-blue-300 underline"
                                >
                                  retry
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {failedChannels.length > 0 && (
                        <button
                          onClick={async () => {
                            for (const [k] of failedChannels) {
                              await retryChannel(draft.id, k);
                            }
                          }}
                          className="mt-2 text-[11px] text-orange-400 hover:text-orange-300 underline"
                        >
                          Retry all failed ({failedChannels.length})
                        </button>
                      )}

                      {publishId === draft.id && (
                        <div className="mt-3 p-3 bg-gray-950 border border-gray-800 rounded-lg">
                          <p className="text-xs text-gray-400 mb-2">Publish to:</p>
                          <div className="flex flex-col gap-1">
                            {activeChannels.map((k) => {
                              const meta = CHANNEL_LABELS[k];
                              if (!meta) return null;
                              return (
                                <label key={k} className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={publishChannels.has(k)}
                                    onChange={() => {
                                      const next = new Set(publishChannels);
                                      if (next.has(k)) next.delete(k);
                                      else next.add(k);
                                      setPublishChannels(next);
                                    }}
                                  />
                                  <span>{meta.long}</span>
                                </label>
                              );
                            })}
                          </div>
                          <div className="flex gap-2 mt-3">
                            <button
                              onClick={() => doPublishMulti(draft.id)}
                              disabled={publishing}
                              className="px-3 py-1 bg-purple-600 text-white text-xs rounded-lg disabled:opacity-50"
                            >
                              {publishing ? "Publishing..." : `Publish to ${publishChannels.size}`}
                            </button>
                            <button
                              onClick={() => setPublishId(null)}
                              className="px-3 py-1 bg-gray-700 text-gray-300 text-xs rounded-lg"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {scheduleId === draft.id && (
                        <div className="flex gap-2 mt-2 items-center">
                          <input
                            type="datetime-local"
                            value={scheduleDate}
                            onChange={(e) => setScheduleDate(e.target.value)}
                            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-sm text-gray-300"
                          />
                          <button onClick={() => saveSchedule(draft.id)} className="px-3 py-1 bg-blue-600 text-white text-xs rounded-lg">
                            Schedule
                          </button>
                          <button onClick={() => setScheduleId(null)} className="px-3 py-1 bg-gray-700 text-gray-300 text-xs rounded-lg">
                            Cancel
                          </button>
                        </div>
                      )}

                      {draft.scheduledAt && (
                        <p className="text-xs text-blue-400 mt-1">
                          Scheduled: {new Date(draft.scheduledAt * 1000).toLocaleString()}
                        </p>
                      )}
                      {draft.publishedAt && (
                        <p className="text-xs text-purple-400 mt-1">
                          Publié le {formatPublishedAt(draft.publishedAt)}
                        </p>
                      )}
                    </div>

                    {draft.status !== "rejected" && (
                      <div className="grid grid-cols-2 md:flex md:flex-col gap-1 md:shrink-0">
                        {draft.status === "draft" && (
                          <button onClick={() => doAction("approve", draft.id)} className="px-3 py-1.5 bg-green-600/20 text-green-400 text-xs rounded-lg hover:bg-green-600/30 border border-green-800/50">
                            Approve
                          </button>
                        )}
                        {(draft.status === "draft" || draft.status === "approved") && (
                          <button
                            onClick={() => {
                              setScheduleId(draft.id);
                              setScheduleDate("");
                            }}
                            className="px-3 py-1.5 bg-blue-600/20 text-blue-400 text-xs rounded-lg hover:bg-blue-600/30 border border-blue-800/50"
                          >
                            Schedule
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setPublishId(draft.id);
                            setPublishChannels(new Set(activeChannels));
                          }}
                          disabled={isPublished(draft)}
                          className={`px-3 py-1.5 bg-purple-600/20 text-purple-400 text-xs rounded-lg border border-purple-800/50 ${isPublished(draft) ? "opacity-40 cursor-not-allowed" : "hover:bg-purple-600/30"}`}
                        >
                          Publish
                        </button>
                        <button
                          onClick={() => {
                            setEditingId(draft.id);
                            setEditTextFr(draft.postText);
                            setEditTextEn(draft.postTextEn || "");
                            setEditTab("fr");
                          }}
                          disabled={isPublished(draft)}
                          className={`px-3 py-1.5 bg-gray-700/50 text-gray-400 text-xs rounded-lg border border-gray-700 ${isPublished(draft) ? "opacity-40 cursor-not-allowed" : "hover:bg-gray-700"}`}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => {
                            setPhotoEditId(draft.id);
                            setPhotoEditUrls([...galleryUrls]);
                          }}
                          disabled={isPublished(draft)}
                          className={`px-3 py-1.5 bg-gray-700/50 text-gray-400 text-xs rounded-lg border border-gray-700 ${isPublished(draft) ? "opacity-40 cursor-not-allowed" : "hover:bg-gray-700"}`}
                        >
                          Photos
                        </button>
                        <button
                          onClick={() => doAction("reject", draft.id)}
                          disabled={isPublished(draft)}
                          className={`px-3 py-1.5 bg-red-600/10 text-red-400 text-xs rounded-lg border border-red-800/50 ${isPublished(draft) ? "opacity-40 cursor-not-allowed" : "hover:bg-red-600/20"}`}
                        >
                          Reject
                        </button>
                        <button
                          onClick={() => {
                            const msg = isPublished(draft)
                              ? "Supprimer ce draft publié? L'historique de publication sera perdu (le post Facebook reste en ligne)."
                              : "Supprimer ce draft?";
                            if (window.confirm(msg)) doAction("delete", draft.id);
                          }}
                          className="px-3 py-1.5 text-gray-600 text-xs rounded-lg hover:text-red-400"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : (
        <CalendarView drafts={calendarDrafts} />
      )}
    </div>
  );
}

function CalendarView({ drafts }: { drafts: Draft[] }) {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const startDay = month.getDay();
  const cells: (Date | null)[] = [];

  for (let i = 0; i < startDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(month.getFullYear(), month.getMonth(), d));

  function draftsForDay(date: Date) {
    const dayStart = Math.floor(date.getTime() / 1000);
    const dayEnd = dayStart + 86400;
    return drafts.filter((d) => {
      const ts = d.scheduledAt || d.publishedAt || 0;
      return ts >= dayStart && ts < dayEnd;
    });
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-4">
        <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="px-3 py-1 text-gray-400 hover:text-white text-sm">
          &larr;
        </button>
        <h3 className="text-white font-medium">
          {month.toLocaleString("default", { month: "long", year: "numeric" })}
        </h3>
        <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="px-3 py-1 text-gray-400 hover:text-white text-sm">
          &rarr;
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-xs">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="text-center text-gray-500 py-1">{d}</div>
        ))}
        {cells.map((date, i) => {
          const dayDrafts = date ? draftsForDay(date) : [];
          const isToday = date && date.toDateString() === new Date().toDateString();
          return (
            <div
              key={i}
              className={`min-h-[60px] p-1 rounded-lg border ${date ? "border-gray-800" : "border-transparent"} ${isToday ? "border-blue-600/50 bg-blue-900/10" : ""}`}
            >
              {date && (
                <>
                  <span className={`text-xs ${isToday ? "text-blue-400 font-bold" : "text-gray-500"}`}>{date.getDate()}</span>
                  {dayDrafts.map((d) => (
                    <div
                      key={d.id}
                      className={`mt-0.5 px-1 py-0.5 rounded text-[10px] truncate ${
                        d.status === "published" ? "bg-purple-900/40 text-purple-400" : "bg-blue-900/40 text-blue-400"
                      }`}
                      title={d.postText.slice(0, 100)}
                    >
                      {d.sku}
                    </div>
                  ))}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
