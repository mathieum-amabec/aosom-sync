/**
 * /api/email/status — dashboard control of our own email engine (session-protected).
 *
 * GET: mode, missing configuration, which groups were taken over from the Klaviyo relays, the flows,
 * 30-day send stats and suppression counts.
 * POST { action }:
 *   - "mode" { mode: off|test|live } — "live" refused while configuration is missing;
 *   - "test-recipients" { value } — comma-separated addresses for mode "test";
 *   - "address" { value } — mailing address printed in every footer (CASL);
 *   - "takeover" { group, on } — move a group from the relays to the engine (or back).
 */
import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { acquireLease, countEmailSuppressions, getEmailSendStats, getSetting, releaseLease, setSetting } from "@/lib/database";
import { RELAY_LEASE_KEY, RELAY_LEASE_TTL_S } from "@/lib/klaviyo-campaigns";
import { ADDRESS_KEY, MODE_KEY, TEST_RECIPIENTS_KEY, configProblems, loadEngineConfig, parseMode, parseRecipients } from "@/lib/email/engine";
import { FLOWS, GROUPS, TAKEOVER_KEY, parseTakeover, type FlowGroup } from "@/lib/email/flows";

export const dynamic = "force-dynamic";

async function status() {
  const cfg = await loadEngineConfig(getSetting);
  const takeover = parseTakeover(await getSetting(TAKEOVER_KEY));
  const [stats, suppressions] = await Promise.all([getEmailSendStats(Math.floor(Date.now() / 1000) - 30 * 86_400), countEmailSuppressions()]);
  return {
    mode: cfg.mode,
    problems: configProblems(cfg),
    testRecipients: [...cfg.testRecipients],
    mailingAddress: cfg.mailingAddress,
    takeover,
    groups: GROUPS.map((g) => ({ group: g, flows: FLOWS.filter((f) => f.group === g).map((f) => ({ key: f.key, consent: f.consent })), since: takeover[g] ?? null })),
    stats,
    suppressions,
  };
}

/** Run a switch under the relays' lease, so no relay or engine run sees it half-done. Returns a 409 when busy. */
async function underLease(fn: () => Promise<void>): Promise<NextResponse | null> {
  const lease = await acquireLease(RELAY_LEASE_KEY, RELAY_LEASE_TTL_S);
  if (!lease) return NextResponse.json({ error: "Un envoi est en cours, réessaie dans une minute." }, { status: 409 });
  try {
    await fn();
    return null;
  } finally {
    await releaseLease(RELAY_LEASE_KEY, lease).catch(() => {});
  }
}

export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await status(), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/email/status failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = (await request.json().catch(() => ({}))) as { action?: string; mode?: string; value?: string; group?: string; on?: boolean };
  const bad = (error: string) => NextResponse.json({ error }, { status: 400 });
  switch (b.action) {
    case "mode": {
      const mode = parseMode(b.mode ?? null);
      if (mode !== b.mode) return bad("mode invalide");
      if (mode !== "off") {
        const problems = configProblems(await loadEngineConfig(getSetting));
        if (problems.length) return bad(`Configuration incomplète : ${problems.join(" · ")}`);
      }
      if (mode === "test" && !parseRecipients(await getSetting(TEST_RECIPIENTS_KEY)).size) return bad("Ajoute d’abord une adresse de test.");
      const busy = await underLease(async () => {
        // (leaving live needs nothing: the relays read the engine's sends on every run — flows.ts mergeEngineInto*)
        const before = parseMode(await getSetting(MODE_KEY));
        const t = parseTakeover(await getSetting(TAKEOVER_KEY));
        // entering live: the hand-over starts now (not when the group was ticked in test mode)
        if (before !== "live" && mode === "live") {
          for (const g of GROUPS) if (t[g]) t[g] = new Date().toISOString();
          await setSetting(TAKEOVER_KEY, JSON.stringify(t));
        }
        await setSetting(MODE_KEY, mode);
      });
      if (busy) return busy;
      break;
    }
    case "test-recipients": {
      const list = parseRecipients(String(b.value ?? ""));
      if (list.size > 10) return bad("10 adresses de test maximum");
      await setSetting(TEST_RECIPIENTS_KEY, [...list].join(","));
      break;
    }
    case "address": {
      const v = String(b.value ?? "").replace(/\s+/g, " ").trim();
      if (v.length < 10 || v.length > 200) return bad("Adresse postale : 10 à 200 caractères");
      await setSetting(ADDRESS_KEY, v);
      break;
    }
    case "takeover": {
      if (!GROUPS.includes(b.group as FlowGroup)) return bad("groupe invalide");
      const group = b.group as FlowGroup;
      const busy = await underLease(async () => {
        const t = parseTakeover(await getSetting(TAKEOVER_KEY));
        if (b.on) t[group] = t[group] ?? new Date().toISOString();
        else delete t[group];
        await setSetting(TAKEOVER_KEY, JSON.stringify(t));
      });
      if (busy) return busy;
      break;
    }
    default:
      return bad("action inconnue");
  }
  return NextResponse.json(await status());
}
