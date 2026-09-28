import { Redis } from "@upstash/redis";

// A real Redis behind Upstash's REST emulator (serverless-redis-http), started as
// service containers by the redis job in CI. See CONTRIBUTING for running it locally.
export function testRedis() {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL ?? "http://localhost:8079",
    token: process.env.UPSTASH_REDIS_REST_TOKEN ?? "postpilot-test",
  });
}
