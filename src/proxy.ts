import { NextResponse, type NextRequest } from "next/server";
import { authorizeDashboard, dashboardAuthChallenge } from "@/lib/security/dashboard-auth";

// The dashboard (and the server actions it posts to itself) sits behind Basic auth with
// the automation secret as the password. Everything else keeps its own authorization:
// QStash signatures on the cron routes, HMAC tokens on the reject page.
export function proxy(request: NextRequest) {
  if (authorizeDashboard(request.headers.get("authorization"))) return NextResponse.next();
  return new NextResponse("Authentication required", dashboardAuthChallenge);
}

export const config = {
  matcher: ["/dashboard", "/dashboard/:path*"],
};
