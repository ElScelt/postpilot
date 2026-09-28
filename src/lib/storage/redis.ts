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

// `automaticDeserialization: false` returns values as the exact strings Redis holds,
// which a compare-and-set needs.
export function redis(options: { automaticDeserialization?: boolean } = {}) {
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
    ...options,
  });
}

// A key read and written as the exact string Redis holds, so that a write can be made
// conditional on nothing having changed since the read.
export type VersionedStore = {
  getRaw(key: string): Promise<string | null>;
  // Writes `next` only while the key still holds `expected`; a missing key counts as "".
  compareAndSet(key: string, expected: string, next: string): Promise<boolean>;
};

export const compareAndSetScript = `
local current = redis.call('GET', KEYS[1]) or ''
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;

export function versionedStore(client: Pick<Redis, "get" | "eval"> = redis({ automaticDeserialization: false })): VersionedStore {
  return {
    getRaw: (key) => client.get<string>(key),
    compareAndSet: async (key, expected, next) => Number(await client.eval(compareAndSetScript, [key], [expected, next])) === 1,
  };
}
