import test from "node:test";
import assert from "node:assert/strict";
import { pingHeartbeat } from "../src/lib/notify/heartbeat";

test("pings the check on success and its fail endpoint on failure", async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input) => { urls.push(String(input)); return new Response("OK"); };
  assert.equal(await pingHeartbeat(true, "https://hc-ping.com/abc/", fetcher), true);
  assert.equal(await pingHeartbeat(false, "https://hc-ping.com/abc/", fetcher), true);
  assert.deepEqual(urls, ["https://hc-ping.com/abc/", "https://hc-ping.com/abc/fail"]);
});

test("is a no-op without a URL and never throws", async () => {
  assert.equal(await pingHeartbeat(true, undefined, async () => { throw new Error("must not be called"); }), false);
  assert.equal(await pingHeartbeat(true, "https://hc-ping.com/abc", async () => { throw new Error("offline"); }), false);
});
