// Read-only: locate ALL newsletter signup blocks (chantier 4).
import { rest, getAsset } from "./_shopify-lib.mjs";
const THEME = "160059195497";

// 1. Footer section group (sections/footer-group.json) — common 2nd newsletter spot.
for (const key of ["sections/footer-group.json", "sections/footer.liquid"]) {
  try {
    const v = await getAsset(key, THEME);
    const hasNews = /newsletter|klaviyo|infolettre|email_form|courriel|s'inscrire|inscription/i.test(v);
    console.log(`\n=== ${key} (newsletter-related: ${hasNews}) ===`);
    if (hasNews && key.endsWith(".json")) {
      const j = JSON.parse(v);
      for (const [id, sec] of Object.entries(j.sections || {})) {
        const blob = JSON.stringify(sec).toLowerCase();
        if (/newsletter|klaviyo|email_form|courriel|infolettre/i.test(blob)) {
          console.log(`  section ${id} [${sec.type}]`);
          if (sec.blocks) console.log(`    blocks: ${[...new Set(Object.values(sec.blocks).map(b=>b.type))].join(", ")}`);
          if (sec.type === "custom-liquid") console.log(`    cl: ${(sec.settings?.custom_liquid||"").replace(/\s+/g," ").slice(0,140)}`);
        }
      }
    }
  } catch (e) { console.log(`${key}: ${e.message}`); }
}

// 2. Rendered home: count email inputs + klaviyo forms + section anchors.
const html = await (await fetch("https://ameublodirect.ca/")).text();
const emailInputs = (html.match(/type=["']email["']/gi) || []).length;
const klaviyoForms = (html.match(/klaviyo-form|klaviyo_form|class="[^"]*klaviyo/gi) || []).length;
const newsletterForms = (html.match(/newsletter/gi) || []).length;
const klaviyoOnsite = /static\.klaviyo\.com|klaviyo\.js|company_id=([A-Za-z0-9]+)/i.exec(html);
console.log("\n=== RENDERED HOME ===");
console.log(`<input type=email> count: ${emailInputs}`);
console.log(`klaviyo form refs: ${klaviyoForms}`);
console.log(`"newsletter" string occurrences: ${newsletterForms}`);
console.log(`klaviyo onsite script: ${klaviyoOnsite ? klaviyoOnsite[0] : "(none)"}`);

// Show the headings/labels near each email input for identification.
const labels = [...html.matchAll(/(s'inscrire|infolettre|newsletter|recevez|abonnez|courriel|10\s*%|rabais|offres)/gi)].slice(0, 12).map(m => m[0]);
console.log(`signup-ish labels seen: ${[...new Set(labels.map(l=>l.toLowerCase()))].join(", ")}`);
