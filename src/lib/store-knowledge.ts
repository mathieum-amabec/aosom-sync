/**
 * Store knowledge for the storefront assistant (Ameublo / Furni) — policies, FAQ, financing,
 * contact — read LIVE from Shopify so the assistant never quotes a stale copy.
 *
 * Sources: the store's pages (FAQ, delivery, returns, terms, payment security, financing,
 * about, contact) and its Shopify policies (shipping, refund, terms, contact). About 40k
 * characters in all, so instead of stuffing everything into every prompt, `searchStoreInfo`
 * splits them into sections and returns only the few that match the shopper's question,
 * each with the URL of the page it came from.
 *
 * Fetched once, cached 1 hour per instance. A Shopify failure returns whatever is cached (or
 * nothing): the assistant then says it doesn't know and points to the contact email rather
 * than inventing a policy.
 */
import { shopifyFetch } from "@/lib/shopify-client";

export interface KnowledgeSection {
  /** Page or policy title, e.g. "Politique de retour". */
  source: string;
  /** Storefront URL of that page (FR; the /en path for EN shoppers is added by the caller). */
  path: string;
  /** Section heading, when the page had one. */
  heading: string;
  text: string;
}

/** Pages worth answering from. Privacy policy deliberately left out (18k chars of legalese). */
const PAGE_HANDLES = [
  "questions-et-reponses",
  "politique-de-livraison",
  "politique-de-retour",
  "conditions-dutilisation",
  "garantie-de-securite-des-paiements",
  "financement",
  "a-propos",
  "contact",
];
const POLICY_TYPES: Record<string, string> = {
  SHIPPING_POLICY: "/policies/shipping-policy",
  REFUND_POLICY: "/policies/refund-policy",
  TERMS_OF_SERVICE: "/policies/terms-of-service",
  CONTACT_INFORMATION: "/policies/contact-information",
};

const TTL_MS = 60 * 60 * 1000;
const SECTION_MAX = 900;
let cache: { sections: KnowledgeSection[]; expiry: number } | null = null;

type Loader = () => Promise<KnowledgeSection[]>;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/**
 * Split page HTML into sections at headings (h1-h4, and <strong>/<b> lines that end in "?",
 * which is how the FAQ marks its questions). Long sections are cut at SECTION_MAX on a
 * sentence boundary so one answer never floods the prompt. Exported for tests.
 */
export function splitSections(source: string, path: string, html: string): KnowledgeSection[] {
  const marked = html
    // The FAQ page embeds its own FAQPage JSON-LD; never let script/style text into answers.
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(h[1-4])[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => `\n@@H@@${t}\n`)
    .replace(/<(strong|b)[^>]*>([^<]{5,200}\?)\s*<\/\1>/gi, (_, __, t) => `\n@@H@@${t}\n`)
    .replace(/<(br|\/p|\/li|\/div)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(marked);
  const sections: KnowledgeSection[] = [];
  let heading = "";
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join(" ").replace(/\s+/g, " ").trim();
    if (body.length >= 20) {
      for (let i = 0; i < body.length; ) {
        let end = Math.min(body.length, i + SECTION_MAX);
        if (end < body.length) {
          const dot = body.lastIndexOf(". ", end);
          if (dot > i + SECTION_MAX / 2) end = dot + 1;
        }
        sections.push({ source, path, heading, text: body.slice(i, end).trim() });
        i = end;
      }
    }
    buf = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("@@H@@")) {
      flush();
      heading = line.slice(5).replace(/\s+/g, " ").trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

async function loadFromShopify(): Promise<KnowledgeSection[]> {
  const query = `{
    shop { shopPolicies { type title body } }
    pages(first: 50) { nodes { handle title body } }
  }`;
  const res = await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({ query }) });
  if (!res.ok) throw new Error(`Shopify ${res.status}`);
  const json = (await res.json()) as {
    data?: {
      shop?: { shopPolicies?: Array<{ type: string; title: string; body: string }> };
      pages?: { nodes?: Array<{ handle: string; title: string; body: string }> };
    };
  };
  const sections: KnowledgeSection[] = [];
  const pages = json.data?.pages?.nodes ?? [];
  for (const handle of PAGE_HANDLES) {
    const p = pages.find((x) => x.handle === handle);
    if (p?.body) sections.push(...splitSections(p.title, `/pages/${handle}`, p.body));
  }
  for (const pol of json.data?.shop?.shopPolicies ?? []) {
    const path = POLICY_TYPES[pol.type];
    if (path && pol.body) sections.push(...splitSections(pol.title, path, pol.body));
  }
  return sections;
}

let loader: Loader = loadFromShopify;

/** Test-only: swap the Shopify loader (null restores it) and drop the cache. */
export function __setKnowledgeLoaderForTests(fn: Loader | null): void {
  loader = fn ?? loadFromShopify;
  cache = null;
}

async function allSections(): Promise<KnowledgeSection[]> {
  if (cache && cache.expiry > Date.now()) return cache.sections;
  try {
    const sections = await loader();
    if (sections.length > 0) cache = { sections, expiry: Date.now() + TTL_MS };
    return sections.length > 0 ? sections : (cache?.sections ?? []);
  } catch (err) {
    console.warn("[store-knowledge] load failed:", err instanceof Error ? err.message : err);
    return cache?.sections ?? [];
  }
}

const STOP = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "est", "sont", "pour", "avec", "dans", "sur", "que",
  "qui", "quoi", "quel", "quelle", "quels", "quelles", "vous", "nous", "mon", "ma", "mes", "votre", "vos", "je", "tu",
  "il", "elle", "on", "pas", "plus", "est-ce", "comment", "combien", "the", "a", "an", "and", "or", "is", "are", "for",
  "with", "in", "on", "to", "of", "my", "your", "do", "does", "can", "how", "what", "much", "many", "you", "we", "it",
]);

/** Accent-free lower-case words of 3+ letters, minus stop words, crude FR/EN plural strip. */
function terms(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => (w.length > 4 ? w.replace(/(x|s)$/, "") : w));
}

/** Common EN shopper words mapped to the FR vocabulary the pages are written in. */
const EN_TO_FR: Record<string, string> = {
  shipping: "livraison", delivery: "livraison", ship: "livraison", deliver: "livraison",
  return: "retour", refund: "remboursement", exchange: "echange", warranty: "garantie",
  guarantee: "garantie", payment: "paiement", pay: "paiement", financing: "financement",
  installment: "versement", cancel: "annulation", order: "commande", damaged: "endommage",
  broken: "brise", assembly: "assemblage", contact: "contact", phone: "telephone", email: "courriel",
  tax: "taxe", price: "prix", discount: "rabais", sale: "solde", stock: "stock", time: "delai",
};

/**
 * The few sections that best answer `question`, best first. Score = matched query terms in
 * the heading (×3) and body (×1). Exported for tests.
 */
export function rankSections(sections: KnowledgeSection[], question: string, limit = 4): KnowledgeSection[] {
  const q = terms(question).flatMap((t) => (EN_TO_FR[t] ? [t, EN_TO_FR[t]] : [t]));
  if (q.length === 0) return [];
  const scored = sections.map((s, i) => {
    const head = new Set(terms(`${s.source} ${s.heading}`));
    const body = new Set(terms(s.text));
    let score = 0;
    for (const t of new Set(q)) {
      if (head.has(t)) score += 3;
      if (body.has(t)) score += 1;
    }
    return { s, i, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.s);
}

/** Look up store policies / FAQ for the assistant's `get_store_info` tool. */
export async function searchStoreInfo(question: string): Promise<KnowledgeSection[]> {
  return rankSections(await allSections(), question.slice(0, 300));
}
