import { Redis } from "@upstash/redis";
import { envValue, type Environment } from "../env";

// The two operations the stores need, so tests can supply a plain in-memory fake.
export type KeyValueStore = {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<unknown>;
};

// The Upstash integration in the Vercel marketplace names its variables KV_REST_API_URL
// and KV_REST_API_TOKEN; a database created in the Upstash console uses the
// UPSTASH_REDIS_REST_ names. Either pair works, and the Upstash names win when both exist.
export function redisCredentials(env: Environment = process.env) {
  const url = envValue("UPSTASH_REDIS_REST_URL", env) ?? envValue("KV_REST_API_URL", env);
  const token = envValue("UPSTASH_REDIS_REST_TOKEN", env) ?? envValue("KV_REST_API_TOKEN", env);
  return url && token ? { url, token } : undefined;
}

// `automaticDeserialization: false` returns values as the exact strings Redis holds,
// which a compare-and-set needs.
// A Redis call takes milliseconds. Without a timeout a hung one would hold the run
// until the platform kills it; with one, the run fails, records why and is retried.
export const redisTimeoutMs = 10_000;

export function redis(options: { automaticDeserialization?: boolean } = {}) {
  const { url, token } = redisCredentials() ?? {};
  if (!url || !token) {
    throw new Error("Missing Redis credentials. Connect Upstash or set its REST URL and token.");
  }
  return new Redis({
    url,
    token,
    signal: () => AbortSignal.timeout(redisTimeoutMs),
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

// The whole value travels twice per write, the expected copy and the new one. The post
// queue is the largest value at about 2 KB a post, capped at 200 finished posts plus
// what is queued, so a write stays under 1 MB against Upstash's 10 MB request limit and
// never needs a version counter or a hash, which would add a key or a Lua function
// Upstash does not document.
export const compareAndSetScript = `
local current = redis.call('GET', KEYS[1]) or ''
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;

const maxWriteAttempts = 5;

// Changes a JSON value in place. The write lands only while the key still holds the
// value `change` saw; otherwise `change` runs again on a fresh read, so concurrent
// writers never undo each other. `change` must therefore only touch the value it is
// given, and throw to refuse.
export async function mutateStored<T, R>(
  store: VersionedStore,
  key: string,
  codec: { parse: (raw: string | null) => T; serialize: (value: T) => string },
  change: (value: T) => R,
): Promise<R> {
  for (let attempt = 0; attempt < maxWriteAttempts; attempt += 1) {
    const raw = await store.getRaw(key);
    const value = codec.parse(raw);
    const result = change(value);
    if (await store.compareAndSet(key, raw ?? "", codec.serialize(value))) return result;
  }
  throw new Error(`${key} kept changing while this write was being made; try again.`);
}

export function versionedStore(client: Pick<Redis, "get" | "eval"> = redis({ automaticDeserialization: false })): VersionedStore {
  return {
    getRaw: (key) => client.get<string>(key),
    compareAndSet: async (key, expected, next) => Number(await client.eval(compareAndSetScript, [key], [expected, next])) === 1,
  };
}
