"use client";

/**
 * The dashboard's one error banner.
 *
 * Before this, a failed mutation either rendered nothing or fired a system
 * `alert()`. Both are bad in different ways: nothing leaves the operator
 * guessing, and a modal blocks the page and cannot be styled or dismissed
 * alongside the thing that failed. Same element everywhere means the operator
 * learns one shape.
 *
 * `role="alert"` so screen readers announce it when it appears.
 */
export type BannerTone = "error" | "success";

const TONES: Record<BannerTone, { box: string; close: string; role: "alert" | "status" }> = {
  error: {
    box: "border-amber-800 bg-amber-950/60 text-amber-100",
    close: "text-amber-300 hover:text-amber-100",
    role: "alert",
  },
  // Success is announced politely: `status` does not interrupt a screen reader
  // mid-sentence the way `alert` does, and nothing is wrong to report.
  success: {
    box: "border-green-800 bg-green-950/50 text-green-100",
    close: "text-green-300 hover:text-green-100",
    role: "status",
  },
};

export function ErrorBanner({
  message,
  tone = "error",
  onDismiss,
  className = "",
}: {
  /** Null or empty renders nothing, so callers can pass state directly. */
  message: string | null;
  tone?: BannerTone;
  onDismiss?: () => void;
  className?: string;
}) {
  if (!message) return null;
  const t = TONES[tone];
  return (
    <div
      role={t.role}
      className={`px-4 py-3 rounded-lg border text-sm flex items-start justify-between gap-4 whitespace-pre-line ${t.box} ${className}`}
    >
      <span>{message}</span>
      {onDismiss && (
        <button onClick={onDismiss} className={`${t.close} shrink-0`} aria-label="Fermer">
          ✕
        </button>
      )}
    </div>
  );
}
