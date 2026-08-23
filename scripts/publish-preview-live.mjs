// ÉTAPE 2+3 — publish the working DRAFT to LIVE (role:main), then confirm the swap.
// Re-runs the gate first; aborts if the live state no longer matches expectation.
import { rest, DRAFT_THEME_ID, LIVE_THEME_ID } from "./_shopify-lib.mjs";
const PREVIEW = DRAFT_THEME_ID, LIVE = LIVE_THEME_ID;

const before = (await (await rest("/themes.json")).json()).themes;
const p0 = before.find((t) => String(t.id) === PREVIEW);
const l0 = before.find((t) => String(t.id) === LIVE);
// Gate on the role only. The name is a historical label that survives a publish, so
// asserting it fails on a correct setup as soon as the draft is a differently-named copy.
if (!p0 || p0.role !== "unpublished")
  throw new Error(`ABORT: preview not in expected state: ${JSON.stringify(p0)}`);
if (!l0 || l0.role !== "main")
  throw new Error(`ABORT: live not in expected state: ${JSON.stringify(l0)}`);
console.log(`Gate re-check OK. Publishing ${PREVIEW} ("${p0.name}") -> role:main ...`);

// ÉTAPE 2 — the publish
const res = await rest(`/themes/${PREVIEW}.json`, {
  method: "PUT",
  body: JSON.stringify({ theme: { id: Number(PREVIEW), role: "main" } }),
});
console.log(`PUT /themes/${PREVIEW}.json -> ${res.status}`);
const body = await res.json();
if (!res.ok) throw new Error(`PUBLISH FAILED: ${res.status} ${JSON.stringify(body)}`);
console.log(`response role: ${body.theme?.role}`);

// ÉTAPE 3 — confirm the swap
const after = (await (await rest("/themes.json")).json()).themes;
const p1 = after.find((t) => String(t.id) === PREVIEW);
const l1 = after.find((t) => String(t.id) === LIVE);
console.log("\n--- AFTER ---");
console.log(`preview ${PREVIEW}: "${p1.name}" role=${p1.role}  ${p1.role === "main" ? "✅ now LIVE" : "❌"}`);
console.log(`old live ${LIVE}: "${l1.name}" role=${l1.role}  ${l1.role === "unpublished" ? "✅ demoted" : "❌"}`);
const swapped = p1.role === "main" && l1.role === "unpublished";
console.log(`\nSWAP: ${swapped ? "CONFIRMED ✅" : "NOT as expected ❌"}`);
process.exit(swapped ? 0 : 1);
