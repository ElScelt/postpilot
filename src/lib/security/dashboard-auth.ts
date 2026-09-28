import { constantTimeEqual } from "./compare";
import { envValue } from "../env";

// HTTP Basic auth against AUTOMATION_SECRET guards the dashboard: browsers remember it,
// the secret never appears in a URL, and no session code is needed. The username is
// ignored.
export function authorizeDashboard(authorization: string | null, secret = envValue("AUTOMATION_SECRET")) {
  if (!secret || !authorization) return false;
  const [scheme, encoded] = authorization.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "basic" || !encoded) return false;
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return false;
  }
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return constantTimeEqual(password, secret);
}

export const dashboardAuthChallenge = {
  status: 401,
  headers: { "WWW-Authenticate": 'Basic realm="postpilot dashboard", charset="UTF-8"' },
} as const;
