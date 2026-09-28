import { z } from "zod";
import { redis, type KeyValueStore } from "../storage/redis";
import { errorMessage } from "../errors";
import { dayMs } from "../scheduling/time";

type TokenReader = Pick<KeyValueStore, "get">;

export type TokenRecord = { accessToken: string; memberId: string; expiresAt: number; connectedAt?: number };

export const tokenSchema = z.looseObject({
  accessToken: z.string(), memberId: z.string(), expiresAt: z.number(), connectedAt: z.number().optional(),
}) satisfies z.ZodType<TokenRecord>;

export type TokenStatus =
  | { state: "missing" }
  | { state: "expired" | "valid"; daysRemaining: number };

const tokenKey = "postpilot:token";

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

export async function loadLinkedInToken(client: TokenReader = redis()): Promise<TokenRecord | null> {
  const stored = await client.get<unknown>(tokenKey);
  if (stored === null) return null;
  const result = tokenSchema.safeParse(stored);
  // The callback reads the stored member to decide who may reconnect, so with
  // LINKEDIN_MEMBER_ID set it skips this read and the new token replaces the old one.
  if (!result.success) {
    throw new Error(`${tokenKey} holds an authorization this version cannot read. Set LINKEDIN_MEMBER_ID and reconnect LinkedIn to replace it.`);
  }
  return result.data;
}

// LinkedIn's limit on the text of a post.
export const maxPostLength = 3000;

// How early the run alerts and the dashboard warns that the authorization is running out:
// enough notice to reconnect on a convenient evening.
export const reconnectWarningDays = 10;

// LinkedIn issues no refresh token for w_member_social, so the only recovery is walking
// the consent flow again. Surfacing the countdown is the difference between a planned
// reconnect and a fortnight of runs that queue posts nothing can publish.
export async function linkedInTokenStatus(now = Date.now(), client: TokenReader = redis()): Promise<TokenStatus> {
  const token = await loadLinkedInToken(client);
  if (!token) return { state: "missing" };
  const daysRemaining = Math.floor((token.expiresAt - now) / dayMs);
  return { state: token.expiresAt <= now ? "expired" : "valid", daysRemaining };
}

// The authorization as one line for the dashboard, with how urgently it needs a reconnect.
export function tokenSummary(token: TokenStatus): { tone: "ok" | "warn" | "bad"; text: string } {
  if (token.state === "missing") return { tone: "bad", text: "LinkedIn is not connected." };
  if (token.state === "expired") return { tone: "bad", text: `LinkedIn authorization expired ${Math.abs(token.daysRemaining)} days ago.` };
  if (token.daysRemaining <= reconnectWarningDays) return { tone: "warn", text: `LinkedIn authorization expires in ${token.daysRemaining} days.` };
  return { tone: "ok", text: `LinkedIn authorization valid for ${token.daysRemaining} more days.` };
}

// Why a publish failed, as far as it matters for trying again. "rejected" means
// LinkedIn cannot have the post: nothing was sent, or LinkedIn refused it or was briefly
// unavailable. "unknown" means LinkedIn may have accepted it: the call timed out or
// broke, or LinkedIn failed in a way it may have after saving the post. Retrying an
// unknown outcome risks posting the same text twice.
export class LinkedInPublishError extends Error {
  constructor(message: string, readonly outcome: "rejected" | "unknown") {
    super(message);
    this.name = "LinkedInPublishError";
  }
}

function publishOutcome(status: number) {
  return (status >= 400 && status < 500) || status === 502 || status === 503 ? "rejected" : "unknown";
}

// Long enough for LinkedIn's slowest ordinary answer, and well inside the publish
// route's own limit so the timeout is recorded before the platform kills the route.
const publishTimeoutMs = 20_000;

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
  let token: TokenRecord;
  try {
    token = await requireToken(client);
  } catch (error) {
    throw new LinkedInPublishError(errorMessage(error), "rejected");
  }
  const response = await linkedInFetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    signal: AbortSignal.timeout(publishTimeoutMs),
    body: JSON.stringify({
      author: `urn:li:person:${token.memberId}`,
      commentary: escapeCommentary(text),
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  }, token.accessToken, fetcher).catch((error: unknown) => {
    throw new LinkedInPublishError(`LinkedIn did not answer: ${errorMessage(error)}`, "unknown");
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new LinkedInPublishError(`LinkedIn rejected the post (${response.status}): ${body}`, publishOutcome(response.status));
  }
  return response.headers.get("x-restli-id") ?? "published";
}
