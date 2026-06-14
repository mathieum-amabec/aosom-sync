// ÉTAPE 4 — fetch live storefront and verify hero title / og:image / meta description / no liquid errors.
const URL = "https://ameublodirect.ca/";
const res = await fetch(URL, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" } });
const html = await res.text();
console.log(`GET ${URL} -> ${res.status}, ${html.length} bytes`);

const rec = (ok, l, d) => console.log(`${ok ? "✅" : "❌"} ${l} — ${d}`);

// Hero title
const heroTitle = "Meublez votre espace à votre image";
rec(html.includes(heroTitle), "Titre hero présent", heroTitle);

// <title> tag
const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
console.log(`   <title>: ${titleTag.trim().slice(0, 120)}`);

// og:image
const og = (html.match(/<meta[^>]+property=["']og:image["'][^>]*>/i) || [])[0] || "";
const ogContent = (og.match(/content=["']([^"']+)["']/i) || [])[1] || "";
rec(!!ogContent && /^https?:\/\//.test(ogContent), "og:image présent (URL)", ogContent.slice(0, 110));

// meta description
const md = (html.match(/<meta[^>]+name=["']description["'][^>]*>/i) || [])[0] || "";
const mdContent = (md.match(/content=["']([^"']*)["']/i) || [])[1] || "";
rec(mdContent.length > 40, "meta description présente + naturelle", `"${mdContent.slice(0, 160)}"`);

// Liquid errors
const liquidErrors = (html.match(/Liquid error[^<]*/gi) || []);
rec(liquidErrors.length === 0, "0 liquid error", liquidErrors.length ? liquidErrors.slice(0, 3).join(" | ") : "aucune occurrence 'Liquid error'");

// horizontal scroll section deployed (sanity that the new theme is live)
rec(/hv-grid/.test(html) || /home-video-showcase/.test(html) || /Voyez-le chez vous/.test(html), "section vidéo présente (nouveau thème live)", "hv-grid / Voyez-le chez vous");
