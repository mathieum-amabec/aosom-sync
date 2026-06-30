// Read-only gate: verify the real theme roles before any write this session.
// User-stated invariant: draft 160606093417 = ONLY write target; live 160584859753 = NEVER touch.
// The stale constants in _shopify-lib.mjs (160213696617/160059195497) are NOT trusted here.
import { rest } from "./_shopify-lib.mjs";

const DRAFT = "160606093417";
const LIVE = "160584859753";

const themes = (await (await rest("/themes.json")).json()).themes;
for (const t of themes) console.log(`${t.id}\t[${t.role}]\t${t.name}`);

const draft = themes.find((t) => String(t.id) === DRAFT);
const live = themes.find((t) => String(t.id) === LIVE);

console.log("\n--- GATE CHECK ---");
console.log(`draft ${DRAFT}: ${draft ? `"${draft.name}" role=${draft.role}` : "NOT FOUND"}`);
console.log(`live  ${LIVE}: ${live ? `"${live.name}" role=${live.role}` : "NOT FOUND"}`);

const draftOk = draft && draft.role !== "main"; // draft must NOT be the published/main theme
const liveOk = live && live.role === "main"; // live must be the published/main theme
console.log(`\nDRAFT writable (not main): ${draftOk ? "YES" : "NO"}`);
console.log(`LIVE is main (protected):  ${liveOk ? "YES" : "NO"}`);
console.log(`\nGATE: ${draftOk && liveOk ? "PASS — safe to write draft only" : "FAIL — STOP, roles unexpected"}`);

// Capture a snapshot of the LIVE theme's index.json updated_at so we can prove non-mutation afterward.
if (live) {
  const res = await rest(`/themes/${LIVE}/assets.json?asset[key]=${encodeURIComponent("templates/index.json")}`);
  if (res.ok) {
    const a = (await res.json()).asset;
    console.log(`\nLIVE templates/index.json updated_at (before): ${a.updated_at}`);
  } else {
    console.log(`\nLIVE templates/index.json read: ${res.status}`);
  }
}
