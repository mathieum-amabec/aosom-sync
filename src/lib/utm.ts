/**
 * UTM tagging for the links we put in Reel captions, so Umami (already on the storefront) can tell which video brought a visit.
 *
 * Only OUR storefront links are touched (ameublodirect.ca / furnishdirect.ca): never a third-party URL. A link that already
 * carries a `utm_source` is left as it is (an operator-written or earlier tag wins). Applied at PUBLISH time, so videos that
 * were approved long ago are tagged too and the stored caption stays clean and editable.
 *
 * Short on purpose: captions are read by people. Example:
 *   https://ameublodirect.ca/products/canape  ->  …/canape?utm_source=facebook&utm_medium=reel&utm_campaign=vitrine&utm_content=v546
 */

const OUR_HOSTS = /^(www\.)?(ameublodirect|furnishdirect)\.ca$/i;
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
// Sentence punctuation glued to the end of a pasted URL is not part of it.
const TRAILING_RE = /[.,;:!?)\]»”]+$/;

export interface UtmParams {
  /** Where the click comes from: "facebook" | "instagram". */
  source: string;
  /** Always "reel" for the videos. */
  medium: string;
  /** What kind of video: the Studio style (vitrine, vote, …) or the batch type (assembly, demand_gen_ext). */
  campaign: string;
  /** Which video: "v<studio video id>" or "q<queue id>". */
  content: string;
}

const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";

/** Tag one URL. Returns it untouched when it is not ours, already tagged, or not parseable. */
export function addUtm(rawUrl: string, p: UtmParams): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (!OUR_HOSTS.test(u.hostname) || u.searchParams.has("utm_source")) return rawUrl;
  u.searchParams.set("utm_source", clean(p.source));
  u.searchParams.set("utm_medium", clean(p.medium));
  u.searchParams.set("utm_campaign", clean(p.campaign));
  u.searchParams.set("utm_content", clean(p.content));
  // `URL` would re-add a "/" to a bare host ("https://ameublodirect.ca" -> ".../"): keep the caller's spelling.
  const out = u.toString();
  return /^https?:\/\/[^/?#]+$/.test(rawUrl) ? out.replace(/\/(\?)/, "$1") : out;
}

/** Tag every storefront link inside a caption, keeping the punctuation that follows it. */
export function tagCaptionLinks(caption: string, p: UtmParams): string {
  return caption.replace(URL_RE, (match) => {
    const trail = match.match(TRAILING_RE)?.[0] ?? "";
    const url = trail ? match.slice(0, -trail.length) : match;
    return addUtm(url, p) + trail;
  });
}
