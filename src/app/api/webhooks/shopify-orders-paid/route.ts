/**
 * POST /api/webhooks/shopify-orders-paid — Shopify `orders/paid` → Meta Conversions API Purchase.
 *
 * Authentication: the subscription's callback URL carries a secret `?t=<token>` (stored in settings.capi_webhook_token,
 * compared in constant time). The payload itself is NOT trusted: only its order id is used and the order is re-read
 * from the Shopify Admin API, so a forged request can at most re-send a real, paid order (deduplicated by event_id).
 * Does nothing unless settings.capi_enabled = "1". Returns 5xx on a Meta failure so Shopify retries (up to ~48 h).
 */
import crypto from "crypto";
import { NextResponse } from "next/server";
import { getSetting } from "@/lib/database";
import { shopifyFetch } from "@/lib/shopify-client";
import {
  alreadySent, capiConfig, isPaidOrder, markSent, purchaseEventFromOrder, sendCapiEvents, type ShopifyOrderLike,
} from "@/lib/meta-capi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function tokenOk(given: string | null, expected: string | null): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const expected = await getSetting("capi_webhook_token");
  if (!tokenOk(url.searchParams.get("t"), expected)) return NextResponse.json({ ok: false }, { status: 401 });

  let id: string | number | undefined;
  try { id = ((await request.json()) as { id?: string | number }).id; } catch { return NextResponse.json({ ok: false }, { status: 400 }); }
  if (id == null || !/^\d{6,20}$/.test(String(id))) return NextResponse.json({ ok: false }, { status: 400 });

  const cfg = await capiConfig();
  if (!cfg.enabled) return NextResponse.json({ ok: true, skipped: "disabled" });

  const res = await shopifyFetch(`/orders/${id}.json`);
  if (!res.ok) return NextResponse.json({ ok: false, error: `order fetch ${res.status}` }, { status: 502 });
  const order = ((await res.json()) as { order: ShopifyOrderLike }).order;
  if (!isPaidOrder(order)) return NextResponse.json({ ok: true, skipped: "not paid or test order" });

  const event = purchaseEventFromOrder(order);
  if (!cfg.testEventCode && (await alreadySent(event.event_id, event.event_name))) return NextResponse.json({ ok: true, skipped: "already sent" });

  const r = await sendCapiEvents([event], { testEventCode: cfg.testEventCode });
  if (!r.ok) {
    console.error(`[CAPI] Purchase ${event.event_id} failed: ${r.error}`);
    return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  }
  if (!cfg.testEventCode) await markSent(event.event_id, event.event_name);
  return NextResponse.json({ ok: true, event_id: event.event_id, received: r.received, test: !!cfg.testEventCode });
}
