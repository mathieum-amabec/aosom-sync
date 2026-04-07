import { NextResponse } from "next/server";
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getUnreadNotificationCount,
} from "@/lib/database";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const unreadOnly = url.searchParams.get("unread") === "true";
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const notifications = await getNotifications({ unreadOnly, limit });
    const unreadCount = await getUnreadNotificationCount();
    return NextResponse.json({ success: true, data: { notifications, unreadCount } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, id } = body;

    if (action === "read" && typeof id === "number") {
      await markNotificationRead(id);
      return NextResponse.json({ success: true });
    }

    if (action === "read-all") {
      await markAllNotificationsRead();
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
