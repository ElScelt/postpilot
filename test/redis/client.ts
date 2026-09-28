import { Redis } from "@upstash/redis";

// A real Redis behind Upstash's REST emulator (serverless-redis-http), started as
// service containers by the redis job in CI. See CONTRIBUTING for running it locally.
// These tests write postpilot:posts itself, so they refuse any server but a local one:
// pointed at a real deployment's database they would overwrite its queue.
export function testRedis(options: { automaticDeserialization?: boolean } = {}) {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? "http://localhost:8079";
  if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
    throw new Error(`npm run test:redis only runs against a local Redis, not ${new URL(url).host}.`);
  }
  return new Redis({ url, token: process.env.UPSTASH_REDIS_REST_TOKEN ?? "postpilot-test", ...options });
}
