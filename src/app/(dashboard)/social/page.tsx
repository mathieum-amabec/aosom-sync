"use client";

import { useState, useEffect, useCallback } from "react";

interface Draft {
  id: number;
  sku: string;
  triggerType: string;
  language: string;
  postText: string;
  imagePath: string | null;
  oldPrice: number | null;
  newPrice: number | null;
  status: string;
  scheduledAt: number | null;
  publishedAt: number | null;
  facebookPostId: string | null;
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

export default function SocialPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [generating, setGenerating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [scheduleId, setScheduleId] = useState<number | null>(null);
  const [scheduleDate, setScheduleDate] = useState("");
  const [view, setView] = useState<"list" | "calendar">("list");

  const fetchDrafts = useCallback(async () => {
    setLoading(true);
    const params = filter !== "all" ? `?status=${filter}` : "";
    const res = await fetch(`/api/social${params}`);
    const data = await res.json();
    if (data.success) setDrafts(data.data);
    setLoading(false);
  }, [filter]);

  useEffect(() => { fetchDrafts(); }, [fetchDrafts]);

  async function doAction(action: string, id: number, extra?: Record<string, unknown>) {
    const res = await fetch("/api/social", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, id, ...extra }),
    });
    const data = await res.json();
    if (!data.success) alert(`Error: ${data.error}`);
    fetchDrafts();
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
    doAction("update", id, { postText: editText });
    setEditingId(null);
  }

  function saveSchedule(id: number) {
    const ts = Math.floor(new Date(scheduleDate).getTime() / 1000);
    doAction("schedule", id, { scheduledAt: ts });
    setScheduleId(null);
  }

  const stats = {
    total: drafts.length,
    draft: drafts.filter((d) => d.status === "draft").length,
    approved: drafts.filter((d) => d.status === "approved").length,
    scheduled: drafts.filter((d) => d.status === "scheduled").length,
    published: drafts.filter((d) => d.status === "published").length,
  };

  // Calendar view data
  const calendarDrafts = drafts.filter((d) => d.scheduledAt || d.publishedAt);

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Social Media</h2>
          <p className="text-gray-400 text-sm mt-1">Facebook draft management</p>
        </div>
        <button
          onClick={generateHighlight}
          disabled={generating}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-500 disabled:opacity-50 transition-colors"
        >
          {generating ? "Generating..." : "Generate Highlight"}
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-3 mb-6">
        {[
          { label: "Total", value: stats.total, color: "text-white" },
          { label: "Drafts", value: stats.draft, color: "text-gray-400" },
          { label: "Approved", value: stats.approved, color: "text-green-400" },
          { label: "Scheduled", value: stats.scheduled, color: "text-blue-400" },
          { label: "Published", value: stats.published, color: "text-purple-400" },
        ].map((s) => (
          <div key={s.label} className="p-3 bg-gray-900 border border-gray-800 rounded-xl text-center">
            <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-gray-500 mt-1">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Filters + View Toggle */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-2">
          {["all", "draft", "approved", "scheduled", "published", "rejected"].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                filter === f
                  ? "bg-blue-600/20 border-blue-600 text-blue-400"
                  : "border-gray-700 text-gray-400 hover:text-white"
              }`}
            >
              {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-gray-900 rounded-lg p-0.5 border border-gray-800">
          <button
            onClick={() => setView("list")}
            className={`px-3 py-1 text-xs rounded-md ${view === "list" ? "bg-gray-700 text-white" : "text-gray-500"}`}
          >
            List
          </button>
          <button
            onClick={() => setView("calendar")}
            className={`px-3 py-1 text-xs rounded-md ${view === "calendar" ? "bg-gray-700 text-white" : "text-gray-500"}`}
          >
            Calendar
          </button>
        </div>
      </div>

      {loading ? (
        <div className="p-8 text-center text-gray-500">Loading...</div>
      ) : view === "list" ? (
        /* List View */
        drafts.length === 0 ? (
          <div className="p-8 bg-gray-900 border border-gray-800 rounded-xl text-center">
            <p className="text-gray-500 text-sm">No drafts yet</p>
            <p className="text-gray-600 text-xs mt-1">Import products or run a sync to trigger draft generation</p>
          </div>
        ) : (
          <div className="space-y-3">
            {drafts.map((draft) => (
              <div key={draft.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex gap-4">
                  {/* Image preview */}
                  <div className="shrink-0">
                    {draft.imagePath ? (
                      <img src={draft.imagePath} alt="" className="w-32 h-[67px] rounded-lg object-cover bg-gray-800" />
                    ) : draft.productImage ? (
                      <img src={draft.productImage} alt="" className="w-32 h-[67px] rounded-lg object-cover bg-gray-800" />
                    ) : (
                      <div className="w-32 h-[67px] rounded-lg bg-gray-800 flex items-center justify-center text-gray-600 text-xs">
                        No image
                      </div>
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium border ${STATUS_STYLES[draft.status] || STATUS_STYLES.draft}`}>
                        {draft.status}
                      </span>
                      <span className="px-2 py-0.5 bg-gray-800 text-gray-400 rounded-md text-xs">
                        {TRIGGER_LABELS[draft.triggerType] || draft.triggerType}
                      </span>
                      <span className="text-xs text-gray-500">{draft.language}</span>
                      <span className="text-xs text-gray-600">{draft.sku}</span>
                    </div>

                    {draft.productName && (
                      <p className="text-sm text-gray-300 font-medium truncate mb-1">{draft.productName}</p>
                    )}

                    {editingId === draft.id ? (
                      <div className="mt-2">
                        <textarea
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg p-2 text-sm text-gray-300 resize-y"
                          rows={4}
                        />
                        <div className="flex gap-2 mt-2">
                          <button onClick={() => saveEdit(draft.id)} className="px-3 py-1 bg-blue-600 text-white text-xs rounded-lg">Save</button>
                          <button onClick={() => setEditingId(null)} className="px-3 py-1 bg-gray-700 text-gray-300 text-xs rounded-lg">Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-gray-400 line-clamp-2">{draft.postText}</p>
                    )}

                    {draft.oldPrice && draft.newPrice && (
                      <p className="text-xs text-gray-500 mt-1">
                        <span className="line-through text-red-400">{draft.oldPrice.toFixed(2)}$</span>
                        {" → "}
                        <span className="text-green-400 font-medium">{draft.newPrice.toFixed(2)}$</span>
                      </p>
                    )}

                    {scheduleId === draft.id && (
                      <div className="flex gap-2 mt-2 items-center">
                        <input
                          type="datetime-local"
                          value={scheduleDate}
                          onChange={(e) => setScheduleDate(e.target.value)}
                          className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-sm text-gray-300"
                        />
                        <button onClick={() => saveSchedule(draft.id)} className="px-3 py-1 bg-blue-600 text-white text-xs rounded-lg">Schedule</button>
                        <button onClick={() => setScheduleId(null)} className="px-3 py-1 bg-gray-700 text-gray-300 text-xs rounded-lg">Cancel</button>
                      </div>
                    )}

                    {draft.scheduledAt && (
                      <p className="text-xs text-blue-400 mt-1">
                        Scheduled: {new Date(draft.scheduledAt * 1000).toLocaleString()}
                      </p>
                    )}
                    {draft.publishedAt && (
                      <p className="text-xs text-purple-400 mt-1">
                        Published: {new Date(draft.publishedAt * 1000).toLocaleString()}
                      </p>
                    )}
                  </div>

                  {/* Actions */}
                  {draft.status !== "published" && draft.status !== "rejected" && (
                    <div className="flex flex-col gap-1 shrink-0">
                      {draft.status === "draft" && (
                        <button onClick={() => doAction("approve", draft.id)} className="px-3 py-1.5 bg-green-600/20 text-green-400 text-xs rounded-lg hover:bg-green-600/30 border border-green-800/50">
                          Approve
                        </button>
                      )}
                      {(draft.status === "draft" || draft.status === "approved") && (
                        <button
                          onClick={() => { setScheduleId(draft.id); setScheduleDate(""); }}
                          className="px-3 py-1.5 bg-blue-600/20 text-blue-400 text-xs rounded-lg hover:bg-blue-600/30 border border-blue-800/50"
                        >
                          Schedule
                        </button>
                      )}
                      {(draft.status === "approved" || draft.status === "scheduled") && (
                        <button onClick={() => doAction("publish", draft.id)} className="px-3 py-1.5 bg-purple-600/20 text-purple-400 text-xs rounded-lg hover:bg-purple-600/30 border border-purple-800/50">
                          Publish
                        </button>
                      )}
                      <button
                        onClick={() => { setEditingId(draft.id); setEditText(draft.postText); }}
                        className="px-3 py-1.5 bg-gray-700/50 text-gray-400 text-xs rounded-lg hover:bg-gray-700 border border-gray-700"
                      >
                        Edit
                      </button>
                      <button onClick={() => doAction("reject", draft.id)} className="px-3 py-1.5 bg-red-600/10 text-red-400 text-xs rounded-lg hover:bg-red-600/20 border border-red-800/50">
                        Reject
                      </button>
                      <button onClick={() => doAction("delete", draft.id)} className="px-3 py-1.5 text-gray-600 text-xs rounded-lg hover:text-red-400">
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        /* Calendar View */
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
              className={`min-h-[60px] p-1 rounded-lg border ${
                date ? "border-gray-800" : "border-transparent"
              } ${isToday ? "border-blue-600/50 bg-blue-900/10" : ""}`}
            >
              {date && (
                <>
                  <span className={`text-xs ${isToday ? "text-blue-400 font-bold" : "text-gray-500"}`}>
                    {date.getDate()}
                  </span>
                  {dayDrafts.map((d) => (
                    <div
                      key={d.id}
                      className={`mt-0.5 px-1 py-0.5 rounded text-[10px] truncate ${
                        d.status === "published"
                          ? "bg-purple-900/40 text-purple-400"
                          : "bg-blue-900/40 text-blue-400"
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
