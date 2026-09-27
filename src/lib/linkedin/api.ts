import { redis, type KeyValueStore } from "../storage/redis";

type TokenReader = Pick<KeyValueStore, "get">;

export type TokenRecord = { accessToken: string; memberId: string; expiresAt: number; connectedAt?: number };

export type TokenStatus =
  | { state: "missing" }
  | { state: "expired" | "valid"; daysRemaining: number };

const tokenKey = "linkedin:token";

// LinkedIn supports each YYYYMM version for at least a year and then answers 426
// NONEXISTENT_VERSION. The newest version comes first; when LinkedIn rejects it the
// request is retried with the next, so a bump that lands early or a sunset that lands
// late costs a log line, never a post. Add the newest version at the front every few
// months and drop any that has sunset.
export const linkedInApiVersions = ["202608", "202601"] as const;

export function linkedInHeaders(accessToken: string, version: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Linkedin-Version": version,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

// Every LinkedIn REST call goes through here so the version fallback applies to all of
// them. Only a 426 moves to the next version; any other answer is returned as is.
export async function linkedInFetch(
  url: string,
  init: Omit<RequestInit, "headers">,
  accessToken: string,
  fetcher: typeof fetch = fetch,
) {
  let response: Response | undefined;
  for (const version of linkedInApiVersions) {
    response = await fetcher(url, { ...init, headers: linkedInHeaders(accessToken, version) });
    if (response.status !== 426) return response;
    console.error(`LinkedIn rejected API version ${version} (426); trying the next one.`);
  }
  return response!;
}

export async function loadLinkedInToken(client: TokenReader = redis()) {
  return client.get<TokenRecord>(tokenKey);
}

// LinkedIn issues no refresh token for w_member_social, so the only recovery is walking
// the consent flow again. Surfacing the countdown is the difference between a planned
// reconnect and a fortnight of runs that queue posts nothing can publish.
export async function linkedInTokenStatus(now = Date.now(), client: TokenReader = redis()): Promise<TokenStatus> {
  const token = await loadLinkedInToken(client);
  if (!token) return { state: "missing" };
  const daysRemaining = Math.floor((token.expiresAt - now) / 86_400_000);
  return { state: token.expiresAt <= now ? "expired" : "valid", daysRemaining };
}

export async function requireToken(client: TokenReader = redis()) {
  const token = await loadLinkedInToken(client);
  if (!token) throw new Error("LinkedIn is not connected. Visit /api/auth/linkedin first.");
  if (token.expiresAt <= Date.now()) throw new Error("LinkedIn authorization expired. Reconnect LinkedIn.");
  return token;
}

// LinkedIn parses commentary as little text format. Every reserved character must be
// backslash-escaped or the parser silently drops the rest of the post.
const reservedCharacters = /[\\|{}@[\]()<>#*_~]/g;

export function escapeCommentary(text: string) {
  return text.replace(reservedCharacters, (character) => `\\${character}`);
}

export async function saveLinkedInToken(token: TokenRecord, store: KeyValueStore = redis()) {
  await store.set(tokenKey, token);
}

export async function publishTextPost(text: string, fetcher: typeof fetch = fetch, client: TokenReader = redis()) {
  const token = await requireToken(client);
  const response = await linkedInFetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    body: JSON.stringify({
      author: `urn:li:person:${token.memberId}`,
      commentary: escapeCommentary(text),
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  }, token.accessToken, fetcher);
  if (!response.ok) throw new Error(`LinkedIn rejected the post (${response.status}): ${await response.text()}`);
  return response.headers.get("x-restli-id") ?? "published";
}
