import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validState } from "@/lib/linkedin/oauth";
import { required } from "@/lib/env";
import { loadLinkedInToken, saveLinkedInToken } from "@/lib/linkedin/api";
import { formatDay } from "@/lib/scheduling/time";

const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });
const profileSchema = z.object({ sub: z.string().min(1) });

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !validState(state) || state !== request.cookies.get("postpilot_oauth_state")?.value) {
    return new NextResponse("Invalid or expired OAuth state. Start again from /api/auth/linkedin.", { status: 400 });
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code", code,
    redirect_uri: required("LINKEDIN_REDIRECT_URI"),
    client_id: required("LINKEDIN_CLIENT_ID"),
    client_secret: required("LINKEDIN_CLIENT_SECRET"),
  });
  const tokenResponse = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!tokenResponse.ok) return new NextResponse(`Token exchange failed: ${await tokenResponse.text()}`, { status: 502 });
  const token = tokenSchema.parse(await tokenResponse.json());
  const profileResponse = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!profileResponse.ok) return new NextResponse(`Profile lookup failed: ${await profileResponse.text()}`, { status: 502 });
  const profile = profileSchema.parse(await profileResponse.json());

  // The consent flow is reachable by any LinkedIn member who finds the URL, and whoever
  // completes it would become the author of every queued post. Bind the deployment to
  // one member: the configured id, or failing that the member who connected first.
  const owner = process.env.LINKEDIN_MEMBER_ID || (await loadLinkedInToken())?.memberId;
  if (owner && profile.sub !== owner) {
    return new NextResponse("This deployment is bound to another LinkedIn member.", { status: 403 });
  }

  const now = Date.now();
  const expiresAt = now + token.expires_in * 1000;
  await saveLinkedInToken({ accessToken: token.access_token, memberId: profile.sub, expiresAt, connectedAt: now });
  const response = new NextResponse(
    `LinkedIn connected as member ${profile.sub}. The authorization expires on ${formatDay(expiresAt)}; `
    + "reconnect before then. You can close this tab.",
  );
  response.cookies.delete("postpilot_oauth_state");
  return response;
}
