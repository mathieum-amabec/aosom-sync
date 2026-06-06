// FIX 5 — strip ```html / ``` code-fence wrapper artifacts from blog article bodies.
// The AI generator wrapped each article's HTML in a markdown fence; the fence markers
// render as literal visible text ("```html" near top, "```" at bottom). Inner HTML is valid.
import { rest, sleep } from "./_shopify-lib.mjs";

const DRY = process.argv.includes("--dry");

// (blogId, articleId, published) — the 16 flagged by inspect-blog.mjs
const TARGETS = [
  ["90302349417", "635594506345", true],
  ["90302349417", "635594473577", true],
  ["90302349417", "635594408041", false],
  ["90302349417", "635594342505", false],
  ["90302349417", "635594244201", false],
  ["90302349417", "635593818217", false],
  ["90302349417", "635593752681", false],
  ["90302349417", "635593687145", false],
  ["90302349417", "635593621609", false],
  ["90302349417", "635593523305", true],
  ["90302349417", "635593457769", false],
  ["90302349417", "635593392233", false],
  ["90302349417", "635593326697", false],
  ["91161428073", "635594440809", true],
  ["91161428073", "635594309737", false],
  ["91161428073", "635593228393", true],
];

function cleanFences(html) {
  // Remove any run of 3+ backticks plus an optional language tag and trailing newline.
  let out = html.replace(/```+[a-zA-Z]*[ \t]*\r?\n?/g, "");
  // collapse a now-empty gap that was "</div>\n\n<article" etc. — tidy double blank lines
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

let changed = 0;
for (const [blogId, artId, published] of TARGETS) {
  const res = await rest(`/blogs/${blogId}/articles/${artId}.json?fields=id,title,body_html`);
  const a = (await res.json()).article;
  const before = a.body_html || "";
  const after = cleanFences(before);
  const fencesBefore = (before.match(/```+/g) || []).length;
  const fencesAfter = (after.match(/```+/g) || []).length;

  console.log(`\n#${artId} [${published ? "PUBLISHED" : "draft"}] "${a.title}"`);
  console.log(`   fences ${fencesBefore} -> ${fencesAfter} | len ${before.length} -> ${after.length} (-${before.length - after.length})`);
  // show the snippets being removed (top + bottom)
  const topFence = before.match(/.{0,18}```+[a-zA-Z]*.{0,18}/);
  const botFence = before.match(/.{0,22}```+[ \t]*$/);
  if (topFence) console.log(`   - top:    …${JSON.stringify(topFence[0])}…`);
  if (botFence) console.log(`   - bottom: …${JSON.stringify(botFence[0])}…`);

  if (after === before) { console.log("   (no change — skipped)"); continue; }
  if (fencesAfter > 0) { console.warn("   ⚠ fences remain after clean — NOT writing, needs review"); continue; }

  if (!DRY) {
    const put = await rest(`/blogs/${blogId}/articles/${artId}.json`, {
      method: "PUT",
      body: JSON.stringify({ article: { id: Number(artId), body_html: after } }),
    });
    if (!put.ok) { console.error("   PUT FAILED", put.status, (await put.text()).slice(0, 200)); continue; }
    console.log("   ✓ written");
    await sleep(550); // rate limit ~2 req/s
  }
  changed++;
}
console.log(`\n${DRY ? "[DRY] would change" : "changed"}: ${changed}/${TARGETS.length}`);
