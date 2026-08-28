/**
 * Print today's assistant token and the theme-snippet change that sends it.
 *
 * The storefront widget lives in the Shopify theme, NOT in this repo, so rolling this out
 * is a two-step dance and the ORDER MATTERS:
 *
 *   1. Paste the snippet below into the theme (widget starts sending the header).
 *   2. THEN set ASSISTANT_SECRET in Vercel and redeploy (route starts requiring it).
 *
 * Do it the other way round and every shopper gets a 403 until the theme catches up. The
 * route treats "no secret configured" as "no token required" precisely to make step 1 safe
 * to ship on its own.
 *
 * Usage:
 *   node-x64 node_modules/tsx/dist/cli.mjs scripts/assistant-token.mts
 *   node-x64 node_modules/tsx/dist/cli.mjs scripts/assistant-token.mts --secret <value>
 */

const { assistantDailyToken } = await import("@/lib/assistant-auth");
const { loadEnvConfig } = await import("@next/env");

loadEnvConfig(process.cwd());

const flagIdx = process.argv.indexOf("--secret");
const secret = (flagIdx !== -1 ? process.argv[flagIdx + 1] : process.env.ASSISTANT_SECRET)?.trim();

if (!secret) {
  console.error("ASSISTANT_SECRET is not set. Generate one with:  openssl rand -hex 32");
  console.error("Then put it in .env.local and in the Vercel project env, or pass --secret <value>.");
  process.exit(1);
}

const today = new Date();
const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

console.log(`UTC day     : ${today.toISOString().slice(0, 10)}`);
console.log(`Token today : ${assistantDailyToken(secret, today)}`);
console.log(`Token yest. : ${assistantDailyToken(secret, yesterday)}   (still accepted — midnight grace)`);
console.log("");
console.log("Smoke test:");
console.log(`  curl -s -X POST https://aosom-sync.vercel.app/api/assistant \\`);
console.log(`    -H 'Origin: https://ameublodirect.ca' \\`);
console.log(`    -H 'Content-Type: application/json' \\`);
console.log(`    -H 'X-Assistant-Token: ${assistantDailyToken(secret, today)}' \\`);
console.log(`    -d '{"message":"un canapé pour petit salon","locale":"fr"}'`);
console.log("");
console.log("─".repeat(78));
console.log("Theme snippet — replace the existing fetch(...) call in the assistant widget:");
console.log("─".repeat(78));
console.log(`
  // Daily assistant token. The secret is visible in theme source (this is a public page),
  // so this is a speed bump against scanners, not authentication — the server-side per-IP
  // quota and the daily token budget are what actually bound spend.
  var ASST_SECRET='${secret}';
  function asstToken(){
    var d=new Date().toISOString().slice(0,10);
    var enc=new TextEncoder();
    return crypto.subtle.importKey('raw',enc.encode(ASST_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign'])
      .then(function(k){return crypto.subtle.sign('HMAC',k,enc.encode(d));})
      .then(function(sig){
        return Array.prototype.map.call(new Uint8Array(sig),function(b){
          return ('00'+b.toString(16)).slice(-2);
        }).join('').slice(0,32);
      });
  }

  // ...then inside the submit handler, await the token before fetching:
  asstToken().then(function(tok){
    return fetch(API,{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Assistant-Token':tok},
      body:JSON.stringify({message:msg,history:history.slice(-8),locale:LOC})
    });
  })
  .then(function(r){return r.json();})
  // ...rest unchanged
`);
console.log("─".repeat(78));
console.log("Reminder: the widget ignores the HTTP status and renders j.data.reply whenever");
console.log("j.success is true — that is why the 429/503 limit responses still carry a reply.");
process.exit(0);
