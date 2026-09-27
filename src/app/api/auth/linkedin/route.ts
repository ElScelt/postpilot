import { NextResponse } from "next/server";
import { signedState } from "@/lib/linkedin/oauth";
import { required } from "@/lib/env";

export async function GET() {
  const state = signedState();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: required("LINKEDIN_CLIENT_ID"),
    redirect_uri: required("LINKEDIN_REDIRECT_URI"),
    state,
    scope: "openid profile w_member_social",
  });
  const response = NextResponse.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params}`);
  response.cookies.set("postpilot_oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/" });
  return response;
}
