import { Redis } from "@upstash/redis";

// The two operations the stores need, so tests can supply a plain in-memory fake.
export type KeyValueStore = {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<unknown>;
};

export function redis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("Missing Redis credentials. Connect Upstash or set its REST URL and token.");
  }
  return new Redis({
    url,
    token,
  });
}
