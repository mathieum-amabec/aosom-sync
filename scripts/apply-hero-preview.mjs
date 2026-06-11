// Chantier 2 — hero refonte on the PREVIEW theme only (160213696617). Never live.
// Rewrites the lc_hero custom_liquid: new headline + subtitle, two CTAs (navy primary
// + outline-gold secondary), a floating badge. Keeps the existing lc-hero.jpg image.
// Idempotent (re-run = no-op once the new headline is present).
import { rest, sleep } from "./_shopify-lib.mjs";

const THEME = "160213696617";
if (THEME === "160059195497") throw new Error("refusing to run against the LIVE theme");
const get = async (k) => (await (await rest(`/themes/${THEME}/assets.json?asset[key]=${encodeURIComponent(k)}`)).json()).asset.value;
async function put(k, v) {
  const r = await rest(`/themes/${THEME}/assets.json`, { method: "PUT", body: JSON.stringify({ asset: { key: k, value: v } }) });
  if (!r.ok) throw new Error(`put ${k}: ${r.status} ${await r.text()}`);
  await sleep(550);
}

const HERO = `{%- assign loc = request.locale.iso_code | downcase -%}<div class="lc-hero" style="position:relative;background:url('{{ 'lc-hero.jpg' | asset_url }}') center/cover no-repeat;min-height:480px;display:flex;align-items:flex-start">
  <div class="lc-hero-ov" style="position:absolute;inset:0;background:linear-gradient(to bottom,rgba(0,0,0,.6) 0%,rgba(0,0,0,.18) 45%,transparent 72%),linear-gradient(to right,rgba(0,0,0,.55) 0%,rgba(0,0,0,.22) 65%,transparent 100%)"></div>
  <div class="page-width lc-hero-in" style="position:relative;color:#fff;max-width:660px;font-family:'DM Sans',sans-serif">
    <span class="lc-hero-badge">&#11088; {% if loc == 'en' %}Quebec service &middot; 30-day returns{% else %}Service qu&eacute;b&eacute;cois &middot; Retours 30 jours{% endif %}</span>
    <h1>{% if loc == 'en' %}Furnish your space, your way.{% else %}Meublez votre espace &agrave; votre image.{% endif %}</h1>
    <p>{% if loc == 'en' %}Modern furniture, free shipping across Canada.{% else %}Mobilier moderne, livraison gratuite partout au Canada.{% endif %}</p>
    <div class="lc-hero-cta">
      <a href="/collections/all" class="lc-btn lc-btn--navy" data-umami-event="Hero CTA shop">{% if loc == 'en' %}Shop now{% else %}Magasinez maintenant{% endif %}</a>
      <a href="/collections/rabais" class="lc-btn lc-btn--gold" data-umami-event="Hero CTA deals">{% if loc == 'en' %}See the deals{% else %}Voir les rabais{% endif %}</a>
    </div>
  </div>
</div>
<style>
  .lc-hero-in{padding:9% 0 52px}
  .lc-hero-badge{display:inline-block;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.34);color:#fff;font-weight:600;font-size:1.25rem;padding:7px 16px;border-radius:999px;margin-bottom:1.1rem;backdrop-filter:blur(4px)}
  .lc-hero h1{font-size:clamp(2.4rem,5vw,4.4rem);line-height:1.08;margin:0 0 1rem;font-weight:700}
  .lc-hero p{font-size:1.7rem;margin:0 0 2rem;max-width:34ch}
  .lc-hero-cta{display:flex;gap:14px;flex-wrap:wrap}
  .lc-btn{display:inline-block;padding:14px 28px;border-radius:8px;font-weight:700;text-decoration:none;font-size:1.5rem;font-family:'DM Sans',sans-serif;transition:transform .15s ease,background .15s ease,color .15s ease}
  .lc-btn--navy{background:#1B2A4A;color:#fff;border:2px solid #1B2A4A}
  .lc-btn--navy:hover{background:#16223c;transform:translateY(-2px)}
  .lc-btn--gold{background:transparent;color:#fff;border:2px solid #C17F3E}
  .lc-btn--gold:hover{background:#C17F3E;color:#fff;transform:translateY(-2px)}
  @media(max-width:749px){.lc-hero-in{text-align:center;margin:0 auto;padding:16% 0 40px}.lc-hero h1{font-size:clamp(1.9rem,6vw,2.6rem)}.lc-hero p{margin-left:auto;margin-right:auto}.lc-hero-cta{justify-content:center}.lc-hero-ov{background:linear-gradient(to bottom,rgba(0,0,0,.78) 0%,rgba(0,0,0,.35) 50%,transparent 82%)!important}}
</style>`;

const idx = JSON.parse(await get("templates/index.json"));
if (!idx.sections.lc_hero) throw new Error("lc_hero section not found");
const already = (idx.sections.lc_hero.settings.custom_liquid || "").includes("votre image");
idx.sections.lc_hero.settings.custom_liquid = HERO;
JSON.parse(JSON.stringify(idx)); // sanity
await put("templates/index.json", JSON.stringify(idx, null, 2));
console.log(already ? "• hero re-applied (was already updated)" : "✔ hero updated (new headline, 2 CTAs, badge)");
console.log("Preview: https://27u5y2-kp.myshopify.com/?preview_theme_id=" + THEME);
