/**
 * Last lock before a "sujet chaud" post goes out. A draft is approved at one moment and published at
 * another (a queue slot can be days away; the "Publier" button can be hit on a stale draft), and a
 * topic goes stale fast: a score from Tuesday or "le Vendredi fou, c'est dans 3 jours" must never
 * reach the page late. So at publish time we re-check, with no I/O:
 *  - the post has not passed its expiry (`expiresAt`, unix seconds, stored with the draft), and
 *  - the caption still passes the HARD blocklist (the list may have grown since the draft was made).
 */
import { checkBrandSafety } from "./safety";

export function hotTopicBlockReason(input: {
  caption: string;
  expiresAt?: number | null;
  nowSec?: number;
}): string | null {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (typeof input.expiresAt === "number" && Number.isFinite(input.expiresAt) && nowSec > input.expiresAt) {
    return `Sujet chaud périmé (expiré le ${new Date(input.expiresAt * 1000).toLocaleDateString("fr-CA", { timeZone: "America/Toronto" })}) — ne pas publier`;
  }
  const verdict = checkBrandSafety(input.caption);
  if (!verdict.safe) return `Sujet chaud bloqué par la liste noire (${verdict.group}: ${verdict.match})`;
  return null;
}
