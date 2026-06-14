// ÉTAPE 4 — fetch live storefront and verify hero title / og:image / meta description / no liquid errors.
const URL = "https://ameublodirect.ca/";
const res = await fetch(URL, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" } });
const html = await res.text();
console.log(`GET ${URL} -> ${res.status}, ${html.length} bytes`);

const rec = (ok, l, d) => console.log(`${ok ? "✅" : "❌"} ${l} — ${d}`);

// Minimal HTML-entity decode for the named/numeric entities the theme emits in headings.
const decode = (s) =>
  s.replace(/&agrave;/g, "à").replace(/&eacute;/g, "é").replace(/&egrave;/g, "è")
    .replace(/&ccedil;/g, "ç").replace(/&ucirc;/g, "û").replace(/&ocirc;/g, "ô")
    .replace(/&acirc;/g, "â").replace(/&ecirc;/g, "ê").replace(/&icirc;/g, "î")
    .replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"');
const text = (raw) => decode(raw.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

// Hero title. The live theme encodes the accent as `&agrave;` and ends with a period, AND the
// page has multiple <h1> tags (a hidden a11y one precedes the hero), so neither a literal
// includes() of the plain-accent string nor "first <h1>" works. Decode the whole HTML and
// substring-match. Actual live hero (2026-06-14): "Meublez votre espace à votre image."
const heroExpected = "Meublez votre espace à votre image";
const heroFound = decode(html).includes(heroExpected);
// Surface which <h1> actually carries it, for the log.
const heroH1 = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => text(m[1])).find(Boolean) || "(none)";
rec(heroFound, "Titre hero présent", `"${heroExpected}" (h1 live: "${heroH1}")`);

// <title> tag — assert the real live title (2026-06-14).
const titleExpected = "Ameublo Direct | Meubles et mobiliers extérieurs";
const titleTag = text((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
rec(titleTag === titleExpected, "<title> correct", `"${titleTag}" (attendu "${titleExpected}")`);

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
