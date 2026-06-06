import { rest } from "./_shopify-lib.mjs";
// Look at the raw body around ``` for two published articles (FR + EN).
const ids = [["90302349417", "635594506345"], ["91161428073", "635593228393"]];
for (const [blogId, artId] of ids) {
  const res = await rest(`/blogs/${blogId}/articles/${artId}.json?fields=id,title,body_html`);
  const a = (await res.json()).article;
  const h = a.body_html || "";
  console.log(`\n========== #${a.id} "${a.title}" (len=${h.length}) ==========`);
  console.log("--- FIRST 400 ---\n" + JSON.stringify(h.slice(0, 400)));
  console.log("--- LAST 300 ---\n" + JSON.stringify(h.slice(-300)));
  // each fence occurrence with context
  const idxs = [];
  let i = h.indexOf("```");
  while (i !== -1) { idxs.push(i); i = h.indexOf("```", i + 3); }
  console.log(`--- fence positions: ${idxs.join(", ")} ---`);
  for (const p of idxs.slice(0, 6)) console.log("   ..." + JSON.stringify(h.slice(Math.max(0, p - 30), p + 40)) + "...");
}
