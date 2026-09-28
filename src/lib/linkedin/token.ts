import { z } from "zod";
import { redis, type KeyValueStore } from "../storage/redis";
import { dayMs } from "../scheduling/time";
import { connectPath } from "./oauth";

export type TokenReader = Pick<KeyValueStore, "get">;

export type TokenRecord = { accessToken: string; memberId: string; expiresAt: number; connectedAt?: number };

export const tokenSchema = z.looseObject({
  accessToken: z.string(), memberId: z.string(), expiresAt: z.number(), connectedAt: z.number().optional(),
}) satisfies z.ZodType<TokenRecord>;

export type TokenStatus =
  | { state: "missing" }
  | { state: "expired" | "valid"; daysRemaining: number };

export const tokenKey = "postpilot:token";

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

export async function saveLinkedInToken(token: TokenRecord, store: KeyValueStore = redis()) {
  await store.set(tokenKey, token);
}

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

export async function requireToken(client: TokenReader = redis()) {
  const token = await loadLinkedInToken(client);
  if (!token) throw new Error(`LinkedIn is not connected. Visit ${connectPath} first.`);
  if (token.expiresAt <= Date.now()) throw new Error("LinkedIn authorization expired. Reconnect LinkedIn.");
  return token;
}
