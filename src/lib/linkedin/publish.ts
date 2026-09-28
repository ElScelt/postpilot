import { requireToken, type TokenReader, type TokenRecord } from "./token";
import { redis } from "../storage/redis";
import { errorMessage } from "../errors";

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

// LinkedIn parses commentary as little text format. Every reserved character must be
// backslash-escaped or the parser silently drops the rest of the post.
const reservedCharacters = /[\\|{}@[\]()<>#*_~]/g;

export function escapeCommentary(text: string) {
  return text.replace(reservedCharacters, (character) => `\\${character}`);
}

// Why a publish failed, as far as it matters for trying again. "rejected" means
// LinkedIn cannot have the post: nothing was sent, or LinkedIn refused it or was briefly
// unavailable. "unknown" means LinkedIn may have accepted it: the call timed out or
// broke, or LinkedIn failed in a way it may have after saving the post. Retrying an
// unknown outcome risks posting the same text twice. A refusal because of the
// authorization carries that reason, so the alert can offer the reconnect link.
export class LinkedInPublishError extends Error {
  constructor(message: string, readonly outcome: "rejected" | "unknown", readonly reason?: "authorization") {
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

export async function publishTextPost(text: string, fetcher: typeof fetch = fetch, client: TokenReader = redis()) {
  let token: TokenRecord;
  try {
    token = await requireToken(client);
  } catch (error) {
    throw new LinkedInPublishError(errorMessage(error), "rejected", "authorization");
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
    throw new LinkedInPublishError(
      `LinkedIn rejected the post (${response.status}): ${body}`,
      publishOutcome(response.status),
      response.status === 401 ? "authorization" : undefined,
    );
  }
  return response.headers.get("x-restli-id") ?? "published";
}
