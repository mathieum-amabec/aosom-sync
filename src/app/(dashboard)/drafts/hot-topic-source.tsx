/**
 * "Sujet chaud" drafts: what the post is built on, shown where Mat approves it — the headline or
 * fact, its date and link, the named subject, any sensitive word found in the source, and the expiry
 * after which the publisher refuses to send it. Everything comes from `facebook_drafts.topic_meta`.
 */
function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function when(sec: number): string {
  return new Date(sec * 1000).toLocaleString("fr-CA", {
    timeZone: "America/Toronto", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

export function HotTopicSource({ meta }: { meta: Record<string, unknown> }) {
  const kind = meta.kind === "calendar" ? "Calendrier" : "Actualité";
  const title = text(meta.sourceTitle);
  const url = text(meta.sourceUrl);
  const safeUrl = url && /^https?:\/\//.test(url) ? url : null;
  const subject = text(meta.subject);
  const why = text(meta.why);
  const published = num(meta.sourcePublished);
  const expiresAt = num(meta.expiresAt);
  const flags = Array.isArray(meta.flags) ? meta.flags.filter((f): f is string => typeof f === "string") : [];

  return (
    <div className="bg-white rounded-lg border shadow-sm p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Sujet chaud — source</h2>
        <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-800 font-medium">{kind}</span>
      </div>

      {flags.length > 0 && (
        <p className="text-sm rounded-md bg-amber-50 border border-amber-200 text-amber-900 px-3 py-2">
          ⚠ Sujet sensible à vérifier avant d&apos;approuver : la source contient « {flags.join(", ")} ».
        </p>
      )}

      {title && (
        <p className="text-sm text-gray-800 leading-relaxed">
          {safeUrl ? (
            <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-600">{title}</a>
          ) : (
            title
          )}
        </p>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-gray-500">
        {subject && (<><dt>Sujet nommé</dt><dd className="text-gray-700">{subject}</dd></>)}
        {published !== null && (<><dt>Source publiée</dt><dd className="text-gray-700">{when(published)}</dd></>)}
        {expiresAt !== null && (<><dt>Périme</dt><dd className="text-gray-700">{when(expiresAt)} — le publisher refuse après</dd></>)}
        {why && (<><dt>Pourquoi</dt><dd className="text-gray-700">{why}</dd></>)}
      </dl>
    </div>
  );
}
