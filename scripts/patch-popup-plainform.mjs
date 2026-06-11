// Replace the popup's {% form 'customer' %} with a plain HTML form (form_type=customer)
// to remove any liquid-error risk in custom_liquid. PREVIEW only.
import { rest, getAsset, putAsset } from "./_shopify-lib.mjs";
const LIVE = "160059195497", PREVIEW = "160213696617";
if (PREVIEW === LIVE) throw new Error("ABORT");
const t = (await (await rest("/themes.json")).json()).themes.find((x) => String(x.id) === PREVIEW);
if (!t || t.role !== "unpublished") throw new Error("ABORT: not unpublished preview");
const idx = JSON.parse(await getAsset("templates/index.json", PREVIEW));
let cl = idx.sections.entry_popup.settings.custom_liquid;

const OLD = `      {%- form 'customer', class: 'lc-pop__form', novalidate: 'novalidate' -%}
        <input type="hidden" name="contact[tags]" value="newsletter, popup-10off">
        <input class="lc-pop__email" type="email" name="contact[email]" required autocomplete="email" placeholder="{% if loc == 'en' %}your@email.com{% else %}votre@courriel.com{% endif %}">
        <button class="lc-pop__btn" type="submit">{% if loc == 'en' %}Get my discount{% else %}Je veux mon rabais{% endif %}</button>
        <p class="lc-pop__msg" role="alert" hidden></p>
      {%- endform -%}`;
const NEW = `      <form class="lc-pop__form" method="post" action="/contact" accept-charset="UTF-8" novalidate>
        <input type="hidden" name="form_type" value="customer">
        <input type="hidden" name="utf8" value="✓">
        <input type="hidden" name="contact[tags]" value="newsletter, popup-10off">
        <input class="lc-pop__email" type="email" name="contact[email]" required autocomplete="email" placeholder="{% if loc == 'en' %}your@email.com{% else %}votre@courriel.com{% endif %}">
        <button class="lc-pop__btn" type="submit">{% if loc == 'en' %}Get my discount{% else %}Je veux mon rabais{% endif %}</button>
        <p class="lc-pop__msg" role="alert" hidden></p>
      </form>`;
if (cl.includes('method="post" action="/contact"')) { console.log("already plain form"); }
else { if (!cl.includes("{%- form 'customer'")) throw new Error("ABORT: form block not found"); cl = cl.replace(OLD, NEW); idx.sections.entry_popup.settings.custom_liquid = cl; await putAsset("templates/index.json", JSON.stringify(idx, null, 2), PREVIEW); console.log("entry_popup form -> plain HTML form, PUT 200"); }
console.log("has {% form %}:", cl.includes("{% form") || cl.includes("{%- form"));
console.log("has plain form:", cl.includes('method="post" action="/contact"'));
