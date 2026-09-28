import type { Redis } from "@upstash/redis";
import { redis } from "./redis";

export type LockClient = Pick<Redis, "set" | "eval">;

// One lock per publish date: postpilot:run-lock:2026-09-07.
export function runLockKey(scheduledFor: Date) {
  return `postpilot:run-lock:${scheduledFor.toISOString().slice(0, 10)}`;
}

// Deletes the lock only while it still holds this run's token. A run that outlived its
// lock must not release the lock a later run has taken since.
export const releaseScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

// A token identifying this run, or undefined when another run holds the lock. The TTL
// is what frees the lock of a run that was killed before it could release it.
export async function acquireRunLock(key: string, ttlSeconds: number, client: LockClient = redis()) {
  const token = crypto.randomUUID();
  return (await client.set(key, token, { nx: true, ex: ttlSeconds })) === "OK" ? token : undefined;
}

export async function releaseRunLock(key: string, token: string, client: LockClient = redis()) {
  await client.eval(releaseScript, [key], [token]);
}
