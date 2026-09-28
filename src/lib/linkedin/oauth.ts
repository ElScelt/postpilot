import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appUrl, required } from "../env";

// Where the owner (re)connects LinkedIn: the consent flow's entry point.
export const connectPath = "/api/auth/linkedin";

export function connectUrl() {
  return `${appUrl()}${connectPath}`;
}

// Holds the signed state between the redirect to LinkedIn and the callback.
export const oauthStateCookie = "postpilot_oauth_state";

export function signedState() {
  const nonce = randomBytes(24).toString("hex");
  const signature = createHmac("sha256", required("LINKEDIN_STATE_SECRET")).update(nonce).digest("hex");
  return `${nonce}.${signature}`;
}

export function validState(state: string | null) {
  if (!state) return false;
  const [nonce, signature] = state.split(".");
  if (!nonce || !signature) return false;
  const expected = createHmac("sha256", required("LINKEDIN_STATE_SECRET")).update(nonce).digest("hex");
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
