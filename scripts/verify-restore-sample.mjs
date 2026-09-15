/**
 * Post-write verification: pulls a spread sample from both checkpoint files
 * (restore + regenerate), re-fetches LIVE Shopify body_html for each, and
 * confirms it reads as French and contains no forbidden supplier name.
 */
import fs from "node:fs";

const STORE = "27u5y2-kp.myshopify.com";
const API = "2025-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const FR_WORDS = /\b(vous|votre|vos|avec|pour|cette|cet|une|des|les|est|sont|plus|sans|dans|qui|que|aux|par|sur|peut|tout|toute)\b/g;
const FR_ACCENTED = /\b(très|déjà|qualité|matériau|conçu|résistant)\b/g;
const EN_WORDS = /\b(you|your|with|for|this|the|and|are|is|from|its|features|specification|includes|provides|easy|design|made)\b/g;
function detectLang(html) {
  const text = (html || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").toLowerCase();
  const fr = (text.match(FR_WORDS) || []).length + (text.match(FR_ACCENTED) || []).length;
  const en = (text.match(EN_WORDS) || []).length;
  if (fr === 0 && en === 0) return "empty";
  if (en > fr * 1.5) return "EN";
  if (fr > en * 1.5) return "FR";
  return "MIXED";
}
const FORBIDDEN = /\b(aosom|outsunny|homcom|qaba|pawhut|vinsetto|soozier|durhand)\b/gi;

function loadOk(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === "ok");
}

const restored = loadOk(".tmp-invest/task-a-restore-checkpoint.jsonl");
const regenerated = loadOk(".tmp-invest/task-a-regen-checkpoint.jsonl");

function pick(arr, n) {
  const step = Math.max(1, Math.floor(arr.length / n));
  const out = [];
  for (let i = 0; out.length < n && i < arr.length; i += step) out.push(arr[i]);
  return out;
}

const sample = [...pick(restored, 18).map((r) => ({ ...r, kind: "restore" })), ...pick(regenerated, 7).map((r) => ({ ...r, kind: "regen" }))];

let lastReq = 0;
async function shopifyReq(url) {
  const wait = 560 - (Date.now() - lastReq);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
  return fetch(url, { headers: { "X-Shopify-Access-Token": TOKEN } });
}

let pass = 0, fail = 0;
const failures = [];
for (const item of sample) {
  const res = await shopifyReq(`https://${STORE}/admin/api/${API}/products/${item.id}.json?fields=id,body_html`);
  const json = await res.json();
  const body = json.product?.body_html || "";
  const lang = detectLang(body);
  const leaks = [...new Set((body.match(FORBIDDEN) || []).map((s) => s.toLowerCase()))];
  const ok = lang === "FR" && leaks.length === 0;
  if (ok) pass++;
  else { fail++; failures.push({ ...item, lang, leaks }); }
  console.log(`${ok ? "PASS" : "FAIL"} [${item.kind}] ${item.id} ${item.handle}  lang=${lang} leaks=${JSON.stringify(leaks)}`);
}

console.log(`\n${pass}/${sample.length} pass (FR, no brand leak). ${fail} failures.`);
if (failures.length) console.log(JSON.stringify(failures, null, 2));
