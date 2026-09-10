import { NextResponse } from "next/server";

export function middleware(request: Request) {
  if (new URL(request.url).pathname === "/health") return NextResponse.json({ status: "ok" });
  return NextResponse.next();
}

export const config = { matcher: "/health" };
