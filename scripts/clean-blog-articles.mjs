// clean-blog-articles.mjs — tidy unpublished blog drafts on both blogs.
//
// Two edits per article (Unsplash credit captions are LEFT ALONE — they are the
// license-required attribution, not body text):
//   #2  Remove the in-body duplicate <h1> + <p class="post-meta"> (the theme already
//       renders article.title as the page H1, so the body <h1> is a second H1).
//   #3  Add summary_html (first prose paragraph, ~155 chars) when it is missing.
//
// Idempotent: an already-clean article (no <h1>, no post-meta, summary present) is skipped.
// Dry-run by default; pass --apply to PUT. Only touches UNPUBLISHED articles.
//
// Usage (Windows ARM64 -> x64 node; bun-x64 crashes on network scripts):
//   node scripts/clean-blog-articles.mjs            # dry-run
//   node scripts/clean-blog-articles.mjs --apply    # PUT changes
import { rest } from "./_shopify-lib.mjs";

const APPLY = process.argv.includes("--apply");
const SUMMARY_MAX = 155;
const BLOGS = [
  { id: "90302349417", label: "FR" },
  { id: "91161428073", label: "EN" },
];

const decode = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "’")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…");

const stripTags = (h) => decode((h || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

// First prose <p>: not an image caption (font-size:0.8rem) and not the post-meta byline.
function firstProseText(body) {
  for (const m of body.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
    const attrs = m[1] || "";
    if (/font-size:\s*0\.8rem/i.test(attrs)) continue; // Unsplash caption
    if (/post-meta/i.test(attrs)) continue; // byline
    const txt = stripTags(m[2]);
    if (txt.length >= 60) return txt;
  }
  return "";
}

function makeSummary(body) {
  const txt = firstProseText(body);
  if (!txt) return "";
  if (txt.length <= SUMMARY_MAX) return txt;
  const cut = txt.slice(0, SUMMARY_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 80 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:]+$/, "") + "…";
}

function cleanBody(body) {
  let out = body;
  const hadH1 = /<h1\b/i.test(out);
  const hadMeta = /<p class="post-meta"/i.test(out);
  // Remove the single in-body duplicate <h1> and the post-meta byline (targeted —
  // leaves images, wrappers, and prose untouched).
  out = out.replace(/\s*<h1\b[^>]*>[\s\S]*?<\/h1>/i, "");
  out = out.replace(/\s*<p class="post-meta"[^>]*>[\s\S]*?<\/p>/i, "");
  // Drop the header wrapper only if it is now empty (won't match if it holds an image).
  out = out.replace(/\s*<header class="post-header"[^>]*>\s*<\/header>/i, "");
  return { out, hadH1, hadMeta };
}

let totalChanged = 0;
let totalScanned = 0;
const errors = [];

for (const blog of BLOGS) {
  const res = await rest(
    `/blogs/${blog.id}/articles.json?published_status=unpublished&limit=250&fields=id,title,body_html,summary_html`
  );
  if (!res.ok) {
    console.log(`[${blog.label}] FETCH FAIL ${res.status}`);
    continue;
  }
  const { articles } = await res.json();
  console.log(`\n========== BLOG ${blog.label} (${blog.id}) — ${articles.length} unpublished ==========`);

  for (const a of articles) {
    totalScanned++;
    const { out: newBody, hadH1, hadMeta } = cleanBody(a.body_html || "");
    const bodyChanged = newBody !== (a.body_html || "");
    const hasSummary = (a.summary_html || "").trim().length > 0;
    const newSummary = hasSummary ? null : makeSummary(newBody);
    const summaryAdded = !hasSummary && !!newSummary;

    if (!bodyChanged && !summaryAdded) {
      console.log(`  ✓ #${a.id} already clean — skip`);
      continue;
    }
    totalChanged++;
    console.log(`  • #${a.id} "${a.title}"`);
    if (hadH1) console.log(`      - remove duplicate <h1>`);
    if (hadMeta) console.log(`      - remove <p class="post-meta">`);
    if (summaryAdded) console.log(`      + summary_html (${newSummary.length}c): ${newSummary}`);
    if (!APPLY) continue;

    const payload = { article: { id: a.id } };
    if (bodyChanged) payload.article.body_html = newBody;
    if (summaryAdded) payload.article.summary_html = newSummary;
    const put = await rest(`/blogs/${blog.id}/articles/${a.id}.json`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    if (!put.ok) {
      const t = await put.text();
      console.log(`      ✗ PUT FAILED ${put.status}: ${t.slice(0, 200)}`);
      errors.push(`#${a.id}: ${put.status}`);
    } else {
      console.log(`      ✓ PUT ok`);
    }
  }
}

console.log(`\n${APPLY ? "APPLIED" : "DRY-RUN"}: ${totalChanged} article(s) to change / ${totalScanned} scanned.`);
if (errors.length) console.log(`ERRORS (${errors.length}): ${errors.join(", ")}`);
if (!APPLY && totalChanged > 0) console.log("Re-run with --apply to write.");
process.exit(errors.length ? 1 : 0);
