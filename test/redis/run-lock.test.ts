import test from "node:test";
import assert from "node:assert/strict";
import { acquireRunLock, releaseRunLock } from "../../src/lib/storage/run-lock";
import { testRedis } from "./client";

const client = testRedis();

test("only the holder's token releases the lock", async (t) => {
  const key = `postpilot:test:run-lock:${crypto.randomUUID()}`;
  t.after(() => client.del(key));
  const token = await acquireRunLock(key, 60, client);
  assert.ok(token);
  assert.equal(await acquireRunLock(key, 60, client), undefined, "a second run is kept out");
  await releaseRunLock(key, "someone-else", client);
  assert.equal(await acquireRunLock(key, 60, client), undefined, "a foreign token leaves the lock alone");
  await releaseRunLock(key, token, client);
  assert.ok(await acquireRunLock(key, 60, client), "the holder's release frees it");
});

test("an expired lock can be taken again, and the old holder's late release leaves the new lock alone", async (t) => {
  const key = `postpilot:test:run-lock:${crypto.randomUUID()}`;
  t.after(() => client.del(key));
  const stale = await acquireRunLock(key, 1, client);
  assert.ok(stale);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const fresh = await acquireRunLock(key, 60, client);
  assert.ok(fresh, "the killed run's lock expired");
  await releaseRunLock(key, stale, client);
  assert.equal(await acquireRunLock(key, 60, client), undefined, "the late release did not free the new run's lock");
});
