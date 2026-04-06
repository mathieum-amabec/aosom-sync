"use client";

import { useState, useEffect } from "react";
import type { ImportJob } from "@/lib/import-pipeline";

const SHOPIFY_ADMIN_URL = "https://admin.shopify.com/store/27u5y2-kp";

export default function ImportPage() {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);

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

  useEffect(() => {
    fetchJobs();
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
        updateJobStatus(jobId, "error");
      }
    } catch {
      updateJobStatus(jobId, "error");
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
        updateJobStatus(jobId, "error");
      }
    } catch {
      updateJobStatus(jobId, "error");
    }
  }

  async function handleGenerateAll() {
    const pending = jobs.filter((j) => j.status === "pending");
    for (const job of pending) {
      await handleGenerate(job.id);
    }
  }

  function updateJob(updated: ImportJob) {
    setJobs((prev) =>
      prev.map((j) => (j.id === updated.id ? updated : j))
    );
  }

  function updateJobStatus(jobId: string, status: string) {
    setJobs((prev) =>
      prev.map((j) =>
        j.id === jobId ? { ...j, status: status as ImportJob["status"] } : j
      )
    );
  }

  const pending = jobs.filter((j) => j.status === "pending").length;
  const reviewing = jobs.filter((j) => j.status === "reviewing").length;
  const done = jobs.filter((j) => j.status === "done").length;

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Import Pipeline</h2>
          <p className="text-gray-400 text-sm mt-0.5">
            Generate content and push to Shopify
          </p>
        </div>
        {pending > 0 && (
          <button
            onClick={handleGenerateAll}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Generate All ({pending})
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        <StatCard label="Total" value={jobs.length} color="text-white" />
        <StatCard label="Pending" value={pending} color="text-yellow-400" />
        <StatCard label="Ready" value={reviewing} color="text-blue-400" />
        <StatCard label="Imported" value={done} color="text-green-400" />
      </div>

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
          {jobs.map((job) => (
            <div
              key={job.id}
              className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center gap-4 p-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <h4 className="text-sm font-medium text-white truncate">
                      {job.product.name}
                    </h4>
                    <ImportStatusBadge status={job.status} />
                  </div>
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
                <div className="flex gap-2 shrink-0">
                  {job.status === "pending" && (
                    <button
                      onClick={() => handleGenerate(job.id)}
                      className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      Generate
                    </button>
                  )}
                  {job.status === "reviewing" && (
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
                  {job.status === "done" && job.shopifyId && (
                    <a
                      href={`${SHOPIFY_ADMIN_URL}/products/${job.shopifyId}`}
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
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
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
  };

  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium border shrink-0 ${
        styles[status] || styles.error
      }`}
    >
      {status === "generating" ? "generating..." : status}
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
        dangerouslySetInnerHTML={{ __html: description }}
      />
      <div className="mt-3 p-2 bg-gray-800/50 rounded text-xs">
        <p className="text-gray-500">
          SEO: <span className="text-gray-300">{seoDescription}</span>
        </p>
      </div>
    </div>
  );
}
