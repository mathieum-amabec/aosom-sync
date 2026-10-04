import { NextResponse } from "next/server";
import { protectedResourceMetadata, originOf, CORS } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export const GET = (request: Request) => NextResponse.json(protectedResourceMetadata(originOf(request)), { headers: CORS });
export const OPTIONS = () => new NextResponse(null, { status: 204, headers: CORS });
