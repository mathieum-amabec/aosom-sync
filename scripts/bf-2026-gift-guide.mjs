#!/usr/bin/env node
/**
 * Christmas gift guide (Black Friday 2026, free sales lever #4): creates the FR article in the "guides" blog
 * and the EN article in the EN "blog" blog as UNPUBLISHED drafts, from .context/bf-2026/gift-guide.json
 * (agent-written, agent-verified). Publish them with the BF collections (~Nov 20): `--publish`.
 *   node-x64 --env-file=.env.local scripts/bf-2026-gift-guide.mjs            # dry-run
 *   node-x64 --env-file=.env.local scripts/bf-2026-gift-guide.mjs --apply    # create drafts
 *   node-x64 --env-file=.env.local scripts/bf-2026-gift-guide.mjs --publish  # make them visible
 */
import fs from "node:fs";
import { loadEnv, rest } from "./_shopify-lib.mjs";

loadEnv();
const APPLY = process.argv.includes("--apply");
const PUBLISH = process.argv.includes("--publish");
const BRAND_RE = /\b(aosom|outsunny|homcom|pawhut|soozier|qaba|vinsetto|costway)\b/i;
const g = JSON.parse(fs.readFileSync(".context/bf-2026/gift-guide.json", "utf8"));
const TARGETS = [
  { lang: "fr", blogHandle: "guides", a: g.fr },
  { lang: "en", blogHandle: "blog", a: g.en },
];

const blogs = (await (await rest("/blogs.json?fields=id,handle")).json()).blogs;
for (const t of TARGETS) {
  // No price or discount figure; the only % allowed is the returns FAQ's 10 % handling fee.
  const noFee = (t.a.html + t.a.meta).replace(/10\s?% (du prix|handling fee)/g, "");
  if (BRAND_RE.test(t.a.html + t.a.title + t.a.meta) || /[$%]/.test(noFee)) throw new Error(`${t.lang}: supplier name, $ or % in text`);
  const blog = blogs.find((b) => b.handle === t.blogHandle);
  if (!blog) throw new Error(`blog ${t.blogHandle} not found`);
  const existing = (await (await rest(`/blogs/${blog.id}/articles.json?handle=${t.a.handle}&fields=id,handle,published_at`)).json()).articles[0];
  console.log(`${t.lang}: blog ${t.blogHandle} · ${t.a.title} · ${existing ? `exists (id ${existing.id}, published_at ${existing.published_at})` : "to create (draft)"}`);
  if (PUBLISH && existing) {
    const r = await rest(`/articles/${existing.id}.json`, { method: "PUT", body: JSON.stringify({ article: { id: existing.id, published: true } }) });
    console.log(`  publish → ${r.status}`);
    continue;
  }
  if (!APPLY || existing) continue;
  const r = await rest(`/blogs/${blog.id}/articles.json`, {
    method: "POST",
    body: JSON.stringify({ article: {
      title: t.a.title, handle: t.a.handle, body_html: t.a.html, author: t.lang === "fr" ? "Ameublo Direct" : "Furnish Direct",
      tags: "noel-2026, black-friday-2026", published: false,
      metafields: [{ namespace: "global", key: "description_tag", type: "single_line_text_field", value: t.a.meta }],
    } }),
  });
  const j = await r.json();
  console.log(`  create → ${r.status} ${j.article ? `id ${j.article.id}, published_at ${j.article.published_at}` : JSON.stringify(j).slice(0, 200)}`);
}
if (!APPLY && !PUBLISH) console.log("DRY-RUN — nothing written.");
