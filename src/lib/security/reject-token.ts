import { createHmac, timingSafeEqual } from "node:crypto";
import { required } from "../env";

// The ntfy topic is readable by anyone who knows its name, so the reject link carries a
// per-post signature rather than a shared secret. Worst case for a leaked token is that
// one post does not go out.
export function rejectToken(id: string) {
  return createHmac("sha256", required("AUTOMATION_SECRET")).update(`reject:${id}`).digest("hex");
}

export function validRejectToken(id: string, token: string | null) {
  if (!token) return false;
  const expected = rejectToken(id);
  return token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
