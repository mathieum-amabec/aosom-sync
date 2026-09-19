/**
 * Turn a failed /api/import/queue response into a sentence the operator can act on.
 *
 * Before this existed, catalog/page.tsx did `if (res.ok) { ... }` with no else, so
 * every non-2xx — a 504 timeout, a 400 over the batch cap, a 401 expired session —
 * produced exactly nothing on screen. The button just sat there. This maps each
 * failure to what the operator should DO about it.
 *
 * Kept out of the page component so it can be unit-tested without mounting React.
 */

import { IMPORT } from "@/lib/config";

/**
 * The catalogue selection is cumulative on purpose — it survives page, filter and
 * search changes so a batch can be assembled across several pages. That makes it
 * easy to drift past the route's cap, which used to surface only as a 400 the UI
 * never displayed. These two decide what the catalogue shows instead.
 */
export function isOverBatchCap(selectedCount: number): boolean {
  return selectedCount > IMPORT.MAX_SKUS_PER_BATCH;
}

/** How many to deselect to get back under the cap. Never negative. */
export function excessOverBatchCap(selectedCount: number): number {
  return Math.max(0, selectedCount - IMPORT.MAX_SKUS_PER_BATCH);
}

export interface SkippedImportSku {
  sku: string;
  reason: string;
}

/**
 * Turn queueForImport's `skipped` list (api/import/queue/route.ts's `skipped`
 * field) into a sentence for the operator. Two reasons reach here today:
 * `already_imported` (silently correct — a sibling SKU in the same PSIN group
 * was already on Shopify, or raced with a concurrent request) and
 * `not_in_feed` (the supplier stopped carrying the SKU between it being
 * catalogued and the operator clicking Confirm — reproduced with 840-158GN,
 * 2026-09). Before this, a batch that skipped everything looked identical to
 * a full success: 200 OK, an empty /import queue, no explanation. Grouped by
 * reason so a batch that skips both kinds reads as two clear sentences
 * instead of one undifferentiated SKU list.
 */
export function describeSkippedImports(skipped: SkippedImportSku[]): string {
  const notInFeed = skipped.filter((s) => s.reason === "not_in_feed").map((s) => s.sku);
  const alreadyImported = skipped.filter((s) => s.reason === "already_imported").map((s) => s.sku);
  const parts: string[] = [];

  if (notInFeed.length > 0) {
    parts.push(
      notInFeed.length === 1
        ? `Ce produit n'est plus disponible chez le fournisseur, retiré de votre sélection : ${notInFeed[0]}.`
        : `${notInFeed.length} produits ne sont plus disponibles chez le fournisseur, retirés de votre sélection : ${notInFeed.join(", ")}.`,
    );
  }

  if (alreadyImported.length > 0) {
    parts.push(
      alreadyImported.length === 1
        ? `1 produit était déjà importé et a été ignoré : ${alreadyImported[0]}.`
        : `${alreadyImported.length} produits étaient déjà importés et ont été ignorés : ${alreadyImported.join(", ")}.`,
    );
  }

  return parts.join(" ") || "Certains produits n'ont pas pu être mis en file.";
}

/** Shape the route sends on a rejected batch (api/import/queue/route.ts). */
interface ImportErrorBody {
  code?: string;
  max?: number;
  received?: number;
  error?: string;
}

/**
 * @param res       the non-ok Response
 * @param sentCount how many SKUs the client tried to send, for the cap message
 */
export async function describeImportFailure(
  res: { status: number; json: () => Promise<unknown> },
  sentCount: number,
): Promise<string> {
  // A platform timeout (504) or a crashed function (502) answers with HTML, not
  // JSON, so this parse has to be allowed to fail. Never let the error handler
  // become the error.
  let body: ImportErrorBody = {};
  try {
    const parsed = await res.json();
    if (parsed && typeof parsed === "object") body = parsed as ImportErrorBody;
  } catch {
    /* non-JSON body — status alone decides the message */
  }

  // 504 Gateway Timeout / 408: the function was killed mid-loop. Products already
  // processed ARE committed (upsertImportJob runs inside the loop), so the honest
  // message says the batch is partial rather than implying nothing happened.
  if (res.status === 504 || res.status === 408) {
    return (
      `Le traitement a pris trop de temps et a été interrompu (${sentCount} produits envoyés). ` +
      `Une partie a pu être ajoutée à la file : vérifiez la page Import, puis réessayez avec moins de produits.`
    );
  }

  if (body.code === "batch_too_large") {
    const max = body.max ?? 0;
    const received = body.received ?? sentCount;
    const excess = Math.max(0, received - max);
    return (
      `Maximum ${max} produits par lot — vous en avez sélectionné ${received}. ` +
      `Désélectionnez-en ${excess} pour continuer.`
    );
  }

  if (res.status === 401) {
    return "Session expirée. Reconnectez-vous, puis relancez l'import.";
  }

  if (res.status === 502 || res.status === 503) {
    return "Le serveur est momentanément indisponible. Réessayez dans un instant.";
  }

  if (res.status >= 500) {
    return `Erreur serveur pendant la mise en file (${res.status}). Aucun produit n'a été ajouté — réessayez, et signalez-le si ça persiste.`;
  }

  // Remaining 4xx: the route's own validation messages ("skus array required",
  // "No valid SKUs provided"). Surface them rather than inventing a new wording.
  if (body.error) return `Import refusé : ${body.error}`;

  return `Import refusé (code ${res.status}). Aucun produit n'a été ajouté.`;
}
