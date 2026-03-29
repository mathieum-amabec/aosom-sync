import { NextResponse } from "next/server";
import { login, logout } from "@/lib/auth";

export async function POST(request: Request) {
  const body = await request.json();

  if (body.action === "logout") {
    await logout();
    return NextResponse.json({ ok: true });
  }

  const success = await login(body.password || "");
  if (!success) {
    return NextResponse.json(
      { ok: false, error: "Invalid password" },
      { status: 401 }
    );
  }

  return NextResponse.json({ ok: true });
}
