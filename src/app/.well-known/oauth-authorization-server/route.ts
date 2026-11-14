import { NextResponse } from "next/server";
import { authorizationServerMetadata, originOf, CORS } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export const GET = (request: Request) => NextResponse.json(authorizationServerMetadata(originOf(request)), { headers: CORS });
export const OPTIONS = () => new NextResponse(null, { status: 204, headers: CORS });
