import { NextResponse } from "next/server";
import { login, logout } from "@/lib/auth";

export async function POST(request: Request) {
  const body = await request.json();

  if (body.action === "logout") {
    await logout();
    return NextResponse.json({ success: true });
  }

  const ok = await login(body.password || "");
  if (!ok) {
    return NextResponse.json({ success: false, error: "Invalid password" }, { status: 401 });
  }

  return NextResponse.json({ success: true });
}
