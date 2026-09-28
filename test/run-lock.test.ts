import test from "node:test";
import assert from "node:assert/strict";
import { acquireRunLock, releaseRunLock, releaseScript, type LockClient } from "../src/lib/storage/run-lock";

// Records the commands; what Redis does with them is checked against a real Redis in
// test/redis/run-lock.test.ts.
function fakeClient(setAnswer: "OK" | null) {
  const calls = { set: [] as unknown[][], eval: [] as unknown[][] };
  const client = {
    set: async (...args: unknown[]) => { calls.set.push(args); return setAnswer; },
    eval: async (...args: unknown[]) => { calls.eval.push(args); return 1; },
  } as unknown as LockClient;
  return { client, calls };
}

test("taking the lock stores a fresh token that expires on its own", async () => {
  const { client, calls } = fakeClient("OK");
  const first = await acquireRunLock("postpilot:run-lock:2026-09-07", 300, client);
  const second = await acquireRunLock("postpilot:run-lock:2026-09-07", 300, client);
  assert.ok(first && second && first !== second, "every run gets its own token");
  assert.deepEqual(calls.set[0], ["postpilot:run-lock:2026-09-07", first, { nx: true, ex: 300 }]);
});

test("a held lock yields no token", async () => {
  const { client } = fakeClient(null);
  assert.equal(await acquireRunLock("postpilot:run-lock:2026-09-07", 300, client), undefined);
});

test("releasing deletes the lock only through the token check", async () => {
  const { client, calls } = fakeClient("OK");
  await releaseRunLock("postpilot:run-lock:2026-09-07", "token-a", client);
  assert.deepEqual(calls.eval[0], [releaseScript, ["postpilot:run-lock:2026-09-07"], ["token-a"]]);
});
