const STYLES: Record<string, string> = {
  completed: "bg-green-900/40 text-green-400 border-green-800/50",
  running: "bg-blue-900/40 text-blue-400 border-blue-800/50",
  failed: "bg-red-900/40 text-red-400 border-red-800/50",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium border ${
        STYLES[status] || STYLES.failed
      }`}
    >
      {status}
    </span>
  );
}
