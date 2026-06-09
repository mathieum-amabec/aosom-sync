/**
 * setup-judgeme-avis-page.mjs — create the Judge.me "Avis clients" reviews page
 * and point the announcement-bar slide at it.
 *
 * Idempotent: re-running reuses an existing `avis-clients` page and only rewrites
 * the announcement link if it differs. Safe to run repeatedly.
 *
 * Background: the announcement-bar Judge.me slide linked to
 * `https://judge.me/reviews/ameublodirect.myshopify.com` which 404s, so the link
 * was removed. This creates a real on-store reviews page (Judge.me renders its
 * all-reviews widget into `.jdgm-all-reviews-page`) and links the slide to it.
 *
 * Run:  node scripts/setup-judgeme-avis-page.mjs
 */
import { rest, getAsset, PREVIEW_THEME_ID } from "./_shopify-lib.mjs";

const THEME = "160059195497"; // live theme
const PAGE_HANDLE = "avis-clients";
const PAGE_TITLE = "Avis clients";
const SLIDE_ID = "announcement_HgkNDf"; // the Judge.me review slide (preferred id)

async function restJson(method, endpoint, body) {
  const res = await rest(endpoint, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, ok: res.ok, json, text };
}

// ─── 1) Ensure the "Avis clients" page exists ───────────────────────────────
// limit=250 is the REST max; this store has far fewer pages. (REST pages has no
// handle filter; GraphQL pages(query:"handle:...") would be needed past 250.)
const list = await restJson("GET", "/pages.json?limit=250");
if (!list.ok) throw new Error(`GET /pages.json -> ${list.status}: ${list.text.slice(0, 300)}`);
const pages = list.json.pages || [];
// Match by handle ONLY — a title substring match (e.g. /avis/i) could reuse an
// unrelated page and then point the slide at a /pages/avis-clients that doesn't exist.
let page = pages.find((p) => p.handle === PAGE_HANDLE);

if (page) {
  console.log(`Page exists: id=${page.id} handle=${page.handle} title=${JSON.stringify(page.title)}`);
} else {
  const created = await restJson("POST", "/pages.json", {
    page: {
      title: PAGE_TITLE,
      handle: PAGE_HANDLE,
      body_html: "<div class='jdgm-all-reviews-page'></div>",
      published: true,
    },
  });
  console.log(`POST /pages.json -> ${created.status}`);
  if (!created.ok) throw new Error(`create page failed: ${created.text.slice(0, 400)}`);
  page = created.json.page;
  console.log(`Page CREATED: id=${page.id} handle=${page.handle}`);
}

// Shopify can append a suffix on handle collision (e.g. avis-clients-1), so derive
// the link from the ACTUAL page handle — never a hardcoded constant.
const link = `/pages/${page.handle}`;

// ─── 2) Point the announcement slide at the page ────────────────────────────
const hdr = JSON.parse(await getAsset("sections/header-group.json", THEME));
const blocks = hdr.sections?.["announcement-bar"]?.blocks ?? {};
// Prefer the known block id, but fall back to locating the Judge.me slide by its
// content (block ids change if the section is re-saved in the theme editor).
let slide = blocks[SLIDE_ID];
if (!slide) {
  slide = Object.values(blocks).find(
    (b) => /avis/i.test(b.settings?.text || "") || /judge\.me/i.test(b.settings?.link || ""),
  );
}
if (!slide) throw new Error(`Judge.me announcement slide not found (id ${SLIDE_ID} or by content)`);

if (slide.settings.link === link) {
  console.log(`Announcement link already = ${link} — no PUT needed.`);
} else {
  console.log(`Announcement link: ${JSON.stringify(slide.settings.link)} -> ${link}`);
  slide.settings.link = link;
  // NOTE: the Assets API has no optimistic concurrency (no If-Match), so this
  // read-modify-write of the shared live theme is last-write-wins over the brief
  // GET→PUT window. Acceptable for a one-shot setup; avoid running concurrently
  // with theme-editor saves.
  const put = await restJson(
    "PUT",
    `/themes/${THEME}/assets.json`,
    { asset: { key: "sections/header-group.json", value: JSON.stringify(hdr) } },
  );
  console.log(`PUT sections/header-group.json -> ${put.status}`);
  if (!put.ok) throw new Error(`PUT failed: ${put.text.slice(0, 400)}`);
}

console.log(`\nDONE — page ${link} live; announcement slide -> ${link}`);
void PREVIEW_THEME_ID;
