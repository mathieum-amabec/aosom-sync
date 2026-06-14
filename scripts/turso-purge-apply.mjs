// DESTRUCTIVE — applies the validated purge inside ONE atomic transaction.
//   price_history   : detected_at < now-30d
//   facebook_drafts : status='published' AND created_at < now-30d
// Both timestamps are epoch seconds (verified). Uses batch(...,"write") which
// wraps the statements in a single transaction and rolls back on any error.
import { createClient } from "@libsql/client";
import { loadEnv } from "./_shopify-lib.mjs";

const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const q = async (sql) => (await db.execute(sql)).rows;
const one = async (sql) => (await q(sql))[0].n;
const E30 = `cast(strftime('%s','now','-30 days') as integer)`;

const phBefore = await one(`SELECT COUNT(*) n FROM price_history`);
const fbBefore = await one(`SELECT COUNT(*) n FROM facebook_drafts`);
const phTarget = await one(`SELECT COUNT(*) n FROM price_history WHERE detected_at < ${E30}`);
const fbTarget = await one(`SELECT COUNT(*) n FROM facebook_drafts WHERE status='published' AND created_at < ${E30}`);

console.log(`BEFORE  price_history=${phBefore}  facebook_drafts=${fbBefore}`);
console.log(`TARGET  price_history=${phTarget}  facebook_drafts(published>30d)=${fbTarget}`);

const res = await db.batch(
  [
    `DELETE FROM price_history WHERE detected_at < ${E30}`,
    `DELETE FROM facebook_drafts WHERE status='published' AND created_at < ${E30}`,
  ],
  "write",
);

const phAfter = await one(`SELECT COUNT(*) n FROM price_history`);
const fbAfter = await one(`SELECT COUNT(*) n FROM facebook_drafts`);
const phDeleted = res[0].rowsAffected;
const fbDeleted = res[1].rowsAffected;

console.log(`DELETED price_history=${phDeleted}  facebook_drafts=${fbDeleted}`);
console.log(`AFTER   price_history=${phAfter}  facebook_drafts=${fbAfter}`);

// sanity: deltas must match rowsAffected
const ok = phBefore - phAfter === phDeleted && fbBefore - fbAfter === fbDeleted;
console.log(ok ? "OK — counts reconcile." : "WARNING — count mismatch!");

// emit a machine-readable summary line for the log step
console.log(
  `RESULT_JSON ${JSON.stringify({ phBefore, phAfter, phDeleted, fbBefore, fbAfter, fbDeleted, ok })}`,
);
await db.close?.();
