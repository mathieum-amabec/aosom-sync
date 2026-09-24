// Applies the "Guide d'achat" collection-hero link (Task C) to sections/main-collection-
// banner.liquid on the DRAFT theme (never live). Idempotent: re-running is a no-op once the
// guide-link block is present. Source of truth for the new content: docs/collection-guide-link.liquid.
//
// Usage:
//   node-x64 --env-file=.env.local scripts/apply-collection-guide-link.mjs           (dry-run)
//   node-x64 --env-file=.env.local scripts/apply-collection-guide-link.mjs --apply
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getAsset, putAsset, getDraftThemeId, getLiveThemeId } from "./_shopify-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");
const ASSET_KEY = "sections/main-collection-banner.liquid";

async function main() {
  const newContent = readFileSync(join(__dirname, "..", "docs", "collection-guide-link.liquid"), "utf8");

  const draftId = await getDraftThemeId();
  const liveId = await getLiveThemeId();
  console.log(`draft (write target): ${draftId}\nlive (never write): ${liveId}`);
  if (draftId === liveId) throw new Error("Refusing: draft resolved to the same id as live.");

  const current = await getAsset(ASSET_KEY, draftId);
  if (current.includes("collection-hero__guide-link")) {
    console.log(`${ASSET_KEY} on ${draftId} already has the guide-link block — nothing to do.`);
    return;
  }

  console.log(`${ASSET_KEY} on ${draftId}: ${current.length} chars → ${newContent.length} chars`);
  if (!APPLY) {
    console.log("Dry-run — pass --apply to write.");
    return;
  }

  await putAsset(ASSET_KEY, newContent, draftId);
  const verify = await getAsset(ASSET_KEY, draftId);
  if (!verify.includes("collection-hero__guide-link")) {
    throw new Error("Write verification failed: guide-link block not found after PUT.");
  }
  console.log(`Applied and verified on draft theme ${draftId}.`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exitCode = 1;
});
