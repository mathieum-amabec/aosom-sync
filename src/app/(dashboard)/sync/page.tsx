"use client";

import { useState, useEffect } from "react";
import type { SyncRun, SyncLogEntry } from "@/types/sync";
import { StatusBadge } from "@/components/status-badge";

export default function SyncHistoryPage() {
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [logs, setLogs] = useState<SyncLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    fetch("/api/sync/history")
      .then((r) => r.json())
      .then((d) => setRuns(d.runs || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function loadLogs(runId: string) {
    setSelectedRun(runId);
    setLogsLoading(true);
    try {
      const res = await fetch(`/api/sync/history?runId=${runId}`);
      const data = await res.json();
      setLogs(data.logs || []);
    } catch {
      setLogs([]);
    }
    setLogsLoading(false);
  }

  return (
    <div className="p-8 max-w-6xl">
      <h2 className="text-2xl font-bold text-white mb-1">Sync History</h2>
      <p className="text-gray-400 text-sm mb-8">
        Past sync runs and detailed change logs
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Runs List */}
        <div className="lg:col-span-1">
          <h3 className="text-sm font-medium text-gray-400 mb-3">
            Sync Runs
          </h3>
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : runs.length === 0 ? (
            <p className="text-gray-600 text-sm p-4 bg-gray-900 border border-gray-800 rounded-xl text-center">
              No sync runs yet
            </p>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => (
                <button
                  key={run.id}
                  onClick={() => loadLogs(run.id)}
                  className={`w-full text-left p-4 rounded-xl border transition-colors ${
                    selectedRun === run.id
                      ? "bg-gray-800 border-blue-700/50"
                      : "bg-gray-900 border-gray-800 hover:border-gray-700"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-white font-medium">
                      {new Date(run.startedAt).toLocaleDateString()}
                    </span>
                    <StatusBadge status={run.status} />
                  </div>
                  <div className="text-xs text-gray-500">
                    {new Date(run.startedAt).toLocaleTimeString()}
                    {run.completedAt && (
                      <span>
                        {" "}
                        &mdash;{" "}
                        {Math.round(
                          (new Date(run.completedAt).getTime() -
                            new Date(run.startedAt).getTime()) /
                            1000
                        )}
                        s
                      </span>
                    )}
                  </div>
                  <div className="flex gap-3 mt-2 text-xs">
                    {run.created > 0 && (
                      <span className="text-green-400">
                        +{run.created} new
                      </span>
                    )}
                    {run.updated > 0 && (
                      <span className="text-blue-400">
                        {run.updated} updated
                      </span>
                    )}
                    {run.archived > 0 && (
                      <span className="text-yellow-400">
                        {run.archived} archived
                      </span>
                    )}
                    {run.errors > 0 && (
                      <span className="text-red-400">
                        {run.errors} errors
                      </span>
                    )}
                    {run.created === 0 &&
                      run.updated === 0 &&
                      run.archived === 0 &&
                      run.errors === 0 && (
                        <span className="text-gray-600">No changes</span>
                      )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Log Details */}
        <div className="lg:col-span-2">
          <h3 className="text-sm font-medium text-gray-400 mb-3">
            Change Log
          </h3>
          {!selectedRun ? (
            <div className="p-12 bg-gray-900 border border-gray-800 rounded-xl text-center">
              <p className="text-gray-600 text-sm">
                Select a sync run to view details
              </p>
            </div>
          ) : logsLoading ? (
            <div className="flex justify-center py-12">
              <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : logs.length === 0 ? (
            <div className="p-12 bg-gray-900 border border-gray-800 rounded-xl text-center">
              <p className="text-gray-600 text-sm">
                No changes in this run
              </p>
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-900">
                    <tr className="border-b border-gray-800 text-gray-400">
                      <th className="px-4 py-3 text-left font-medium">
                        Action
                      </th>
                      <th className="px-4 py-3 text-left font-medium">
                        SKU
                      </th>
                      <th className="px-4 py-3 text-left font-medium">
                        Field
                      </th>
                      <th className="px-4 py-3 text-left font-medium">
                        Old
                      </th>
                      <th className="px-4 py-3 text-left font-medium">
                        New
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr
                        key={log.id}
                        className="border-b border-gray-800/50"
                      >
                        <td className="px-4 py-2.5">
                          <ActionBadge action={log.action} />
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs text-gray-400">
                          {log.sku}
                        </td>
                        <td className="px-4 py-2.5 text-gray-300 text-xs">
                          {log.field}
                        </td>
                        <td className="px-4 py-2.5 text-red-400/70 text-xs max-w-[150px] truncate">
                          {log.oldValue || "—"}
                        </td>
                        <td className="px-4 py-2.5 text-green-400/70 text-xs max-w-[150px] truncate">
                          {log.newValue || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionBadge({ action }: { action: string }) {
  const styles: Record<string, string> = {
    create: "text-green-400",
    update: "text-blue-400",
    archive: "text-yellow-400",
  };
  return (
    <span className={`text-xs font-medium ${styles[action] || "text-gray-400"}`}>
      {action}
    </span>
  );
}
