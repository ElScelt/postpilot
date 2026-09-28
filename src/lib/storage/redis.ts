import { Redis } from "@upstash/redis";

// The two operations the stores need, so tests can supply a plain in-memory fake.
export type KeyValueStore = {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<unknown>;
};

// The Upstash integration in the Vercel marketplace names its variables KV_REST_API_URL
// and KV_REST_API_TOKEN; a database created in the Upstash console uses the
// UPSTASH_REDIS_REST_ names. Either pair works, and the Upstash names win when both exist.
export function redisCredentials(env: Partial<Record<string, string>> = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL?.trim() || env.KV_REST_API_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim() || env.KV_REST_API_TOKEN?.trim();
  return url && token ? { url, token } : undefined;
}

export function redis() {
  const { url, token } = redisCredentials() ?? {};
  if (!url || !token) {
    throw new Error("Missing Redis credentials. Connect Upstash or set its REST URL and token.");
  }
  // A Redis call takes milliseconds. Without a timeout a hung one would hold the run
  // until the platform kills it; with one, the run fails, records why and is retried.
  return new Redis({
    url,
    token,
    signal: () => AbortSignal.timeout(10_000),
  });
}
