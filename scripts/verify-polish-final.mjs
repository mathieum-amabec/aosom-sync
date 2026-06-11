import { getAsset } from "./_shopify-lib.mjs";
const P = "160213696617";
const rec = (ok, label, detail) => console.log(`${ok ? "✅" : "❌"} ${label} — ${detail}`);

const idx = JSON.parse(await getAsset("templates/index.json", P));
const hg = await getAsset("sections/header-group.json", P);
const homeJson = JSON.stringify(idx.sections);

// 1. max 2 "livraison gratuite" on the home (index sections + announcement bar)
const livIdx = (homeJson.match(/livraison gratuite/gi) || []).length;
const livHg = (hg.match(/livraison gratuite/gi) || []).length;
rec(livIdx + livHg <= 2, "max 2 'livraison gratuite' on home", `index=${livIdx} (why_us) + announcement=${livHg} = ${livIdx + livHg}`);

// 2. 0 ALL-CAPS marketing in index sections
const caps = [...new Set((homeJson.match(/[A-ZÀ-ÖØ-Þ]{2,}(?:\s*[|·/]\s*[A-ZÀ-ÖØ-Þ]{2,})+/g) || []))];
rec(caps.length === 0, "0 ALL-CAPS marketing (index)", caps.length ? caps.join(" ; ") : "none");

// 3. popup present + complete
const pop = idx.sections.entry_popup?.settings?.custom_liquid || "";
const popOk = !!idx.sections.entry_popup && idx.order.includes("entry_popup") && /10%/.test(pop) && /name="contact\[email\]"/.test(pop) && /data-pop-close/.test(pop) && /localStorage/.test(pop) && /setTimeout\(show,5000\)/.test(pop) && /sc\/h>=0\.5/.test(pop);
rec(popOk, "entry popup present + complete", `section+order, 10%, email field, close×, localStorage, 5s + 50% scroll`);
rec(!/\{%-?\s*form /.test(pop) && /method="post" action="\/contact"/.test(pop), "popup form is liquid-safe", "plain HTML form_type=customer (no {% form %})");

// 4. why_us improved
const w = idx.sections.why_us.settings.custom_liquid;
const pts = ["Catalogue de 490+ produits", "Livraison gratuite au Canada", "Retours faciles 30 jours", "Service client québécois"];
const haveAll = pts.every((p) => w.includes(p));
const truckOnce = (w.match(/Livraison gratuite/gi) || []).length === 1;
rec(haveAll && w.includes("#FAFAF8") && truckOnce, "why_us premium (4 points, #FAFAF8)", `4pts=${haveAll}, bg=${w.includes("#FAFAF8")}, truck once=${truckOnce}`);

// 5. no liquid error / rich_text gone / emoji gone
rec(!idx.sections.rich_text, "redundant rich_text removed", idx.sections.rich_text ? "still present" : "removed");
rec(!/🔥/.test(idx.sections.featured_sale.settings.title), "no 🔥 in featured_sale heading", idx.sections.featured_sale.settings.title);
const live = await (await fetch(`https://ameublodirect.ca/?cb=${Date.now()}`, { cache: "no-store" })).text();
rec(!/liquid error/i.test(live), "no liquid error (live home)", /liquid error/i.test(live) ? "FOUND" : "none");
