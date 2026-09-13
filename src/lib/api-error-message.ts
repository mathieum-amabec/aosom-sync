/**
 * Shared failure wording for dashboard mutations.
 *
 * The 2026-09-13 import investigation found the same shape in six other places:
 * a POST/PUT/DELETE whose failure either had no branch at all, or had one that
 * only flipped some internal state, or shouted through a system `alert()`. The
 * operator either saw nothing or saw a modal with a raw server string.
 *
 * This is the one place that turns a failure into a sentence, so all of them read
 * the same. Import keeps its own extras (batch cap, partial-write wording) in
 * lib/import-error-message.ts and delegates the generic statuses here.
 */

interface ApiErrorBody {
  error?: string;
  message?: string;
}

/** Pull the server's own wording out of a body that may not even be JSON. */
async function readErrorBody(res: { json: () => Promise<unknown> }): Promise<ApiErrorBody> {
  try {
    const parsed = await res.json();
    if (parsed && typeof parsed === "object") return parsed as ApiErrorBody;
  } catch {
    // A platform 502/504 answers with HTML. Never let the error handler throw.
  }
  return {};
}

/**
 * @param res    the non-ok Response
 * @param action what the operator was doing, capitalised, e.g. "L'enregistrement"
 */
export async function describeApiFailure(
  res: { status: number; json: () => Promise<unknown> },
  action = "L'opération",
): Promise<string> {
  const body = await readErrorBody(res);
  const detail = body.error || body.message;

  if (res.status === 401) return "Session expirée. Reconnectez-vous, puis réessayez.";
  if (res.status === 403) return "Action non autorisée avec ce compte.";
  if (res.status === 404) return `${action} a échoué : la ressource n'existe plus (404). Rafraîchissez la page.`;
  if (res.status === 408 || res.status === 504) {
    return `${action} a pris trop de temps et a été interrompue. Rafraîchissez pour voir ce qui a été appliqué avant de réessayer.`;
  }
  if (res.status === 429) return "Trop de requêtes d'affilée. Patientez quelques secondes, puis réessayez.";
  if (res.status === 502 || res.status === 503) {
    return "Le serveur est momentanément indisponible. Réessayez dans un instant.";
  }
  if (res.status >= 500) {
    return `${action} a échoué côté serveur (${res.status})${detail ? ` : ${detail}` : ""}. Réessayez, et signalez-le si ça persiste.`;
  }
  if (detail) return `${action} a échoué : ${detail}`;
  return `${action} a échoué (code ${res.status}).`;
}

/**
 * For routes that answer 200 with `{ success: false, error }` — the convention
 * across /api/social, /api/collections and /api/videos. `res.ok` is true there,
 * so a status-based check alone would call it a success.
 */
export function describePayloadFailure(error: unknown, action = "L'opération"): string {
  const detail = typeof error === "string" && error.trim() ? error.trim() : null;
  return detail ? `${action} a échoué : ${detail}` : `${action} a échoué.`;
}

/** Network-level failure (offline, DNS, reset). fetch() only rejects for these. */
export function describeNetworkFailure(action = "L'opération"): string {
  return `Connexion impossible — ${action.toLowerCase()} n'a pas été envoyée. Vérifiez votre réseau, puis réessayez.`;
}
