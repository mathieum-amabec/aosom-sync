// Read-only PageSpeed-ish audit of the live home HTML.
const res = await fetch("https://ameublodirect.ca/?cb=" + Date.now(), { cache: "no-store" });
const html = await res.text();
const head = html.slice(html.indexOf("<head"), html.indexOf("</head>") + 7);
console.log("HTML size:", (html.length / 1024).toFixed(0), "KB | status", res.status);

// --- images ---
const imgs = html.match(/<img\b[^>]*>/gi) || [];
const lazy = imgs.filter((t) => /loading=["']lazy["']/i.test(t)).length;
const eager = imgs.filter((t) => /loading=["']eager["']/i.test(t)).length;
const none = imgs.length - lazy - eager;
console.log(`\nIMAGES: total=${imgs.length} | lazy=${lazy} | eager=${eager} | no loading attr=${none}`);
const noDims = imgs.filter((t) => !/width=/.test(t) || !/height=/.test(t)).length;
console.log(`  images missing width/height: ${noDims} (CLS risk)`);

// --- head scripts (render-blocking) ---
const headScripts = head.match(/<script\b[^>]*>/gi) || [];
const blocking = headScripts.filter((t) => /src=/i.test(t) && !/async|defer|type=["']module["']/i.test(t));
console.log(`\nHEAD <script>: ${headScripts.length} total | render-blocking (src, no async/defer): ${blocking.length}`);
blocking.slice(0, 8).forEach((t) => console.log("  blocking:", (t.match(/src=["']([^"']+)/) || [])[1]));

// --- head CSS ---
const headCss = (head.match(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi) || []);
console.log(`\nHEAD stylesheets: ${headCss.length}`);

// --- fonts: DM Sans ---
console.log("\nFONTS:");
console.log("  'DM Sans' referenced in HTML:", /DM\s*Sans/i.test(html));
console.log("  font-face / @font-face:", /@font-face|font_face|fonts\.shopifycdn|fonts\.gstatic|fonts\.googleapis/i.test(html));
console.log("  <link rel=preload as=font>:", /rel=["']preload["'][^>]*as=["']font["']/i.test(html));
const dmMatch = html.match(/[^;{}\s]*dm[_-]?sans[^;}"')]*/i);
console.log("  DM Sans token:", dmMatch ? dmMatch[0].slice(0, 60) : "(none)");

// --- heavy resources ---
console.log("\nHEAVY:");
console.log("  total <script> tags:", (html.match(/<script\b/gi) || []).length);
console.log("  inline <script> bytes (approx):", (html.match(/<script\b(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi) || []).join("").length);
console.log("  <video> tags:", (html.match(/<video\b/gi) || []).length);
console.log("  iframes:", (html.match(/<iframe\b/gi) || []).length);
console.log("  external <script src> hosts:", [...new Set((html.match(/<script[^>]+src=["']([^"']+)["']/gi) || []).map((s) => { const u = (s.match(/src=["']([^"']+)/) || [])[1] || ""; try { return new URL(u, "https://x").host; } catch { return u; } }))].join(", "));
