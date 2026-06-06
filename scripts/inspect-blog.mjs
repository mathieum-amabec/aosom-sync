// FIX 5 inspection — scan all blog articles for raw/visible HTML & unconverted markdown.
import { rest, sleep } from "./_shopify-lib.mjs";

const blogsRes = await rest("/blogs.json?limit=250");
const { blogs } = await blogsRes.json();
console.log(`Blogs: ${blogs.map((b) => `${b.title}(${b.handle},id=${b.id})`).join(" | ")}\n`);

function detect(html) {
  const issues = [];
  if (!html) return issues;
  // 1) HTML-entity-encoded tags that will render as literal text
  if (/&lt;\/?[a-z][a-z0-9]*(\s[^&]*)?&gt;/i.test(html)) issues.push("entity-encoded-tags(&lt;p&gt;)");
  // 2) markdown headings at line start
  if (/(^|\n)\s{0,3}#{1,6}\s+\S/.test(html)) issues.push("md-heading(#)");
  // 3) markdown bold/italic
  if (/\*\*[^*\n]+\*\*/.test(html)) issues.push("md-bold(**)");
  // 4) markdown links / images
  if (/!?\[[^\]]+\]\([^)]+\)/.test(html)) issues.push("md-link([]())");
  // 5) code fences / json fences
  if (/```|~~~/.test(html)) issues.push("code-fence(```)");
  if (/(^|\n)\s*```?\s*json/i.test(html) || /^\s*\{[\s"]/.test(html.trim())) issues.push("json-artifact");
  // 6) literal escaped tag text like &lt;p&gt; already covered; also raw "<p>" shown as text is normal HTML — skip
  // 7) markdown unordered list markers at line start (- or *) followed by space, many lines
  const mdList = (html.match(/(^|\n)\s{0,3}[-*]\s+\S/g) || []).length;
  if (mdList >= 3 && !/<(ul|ol|li)\b/i.test(html)) issues.push(`md-list(${mdList} items, no <ul>)`);
  // 8) leftover template/markdown horizontal rules
  if (/(^|\n)\s*---\s*(\n|$)/.test(html)) issues.push("md-hr(---)");
  return issues;
}

let totalArticles = 0;
const flagged = [];
for (const blog of blogs) {
  let pageInfo = null;
  do {
    const params = new URLSearchParams({ limit: "250", fields: "id,title,handle,published_at,body_html" });
    if (pageInfo) params.set("page_info", pageInfo);
    const res = await rest(`/blogs/${blog.id}/articles.json?${params}`);
    const data = await res.json();
    for (const a of data.articles) {
      totalArticles++;
      const issues = detect(a.body_html);
      const published = !!a.published_at;
      if (issues.length) {
        flagged.push({ blog: blog.handle, id: a.id, title: a.title, published, issues, len: (a.body_html || "").length });
      }
    }
    const link = res.headers.get("Link") || "";
    const m = link.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    pageInfo = m ? m[1] : null;
    await sleep(500); // rate limit 2 req/s
  } while (pageInfo);
}

console.log(`Total articles scanned: ${totalArticles}`);
console.log(`Flagged: ${flagged.length}\n`);
for (const f of flagged) {
  console.log(`#${f.id} [${f.blog}] pub=${f.published} len=${f.len} :: "${f.title}"`);
  console.log(`   issues: ${f.issues.join(", ")}`);
}
