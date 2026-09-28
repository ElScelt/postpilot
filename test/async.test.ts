import test from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "../src/lib/async";

test("withTimeout passes a prompt answer through", async () => {
  assert.equal(await withTimeout(Promise.resolve("done"), 1000, "The call"), "done");
});

test("withTimeout stops waiting for a call that hangs and names it", async () => {
  const hanging = new Promise<never>(() => {});
  await assert.rejects(() => withTimeout(hanging, 20, "QStash"), /QStash did not answer within 0.02 seconds/);
});

test("withTimeout passes the call's own failure through", async () => {
  await assert.rejects(() => withTimeout(Promise.reject(new Error("QStash 402")), 1000, "QStash"), /QStash 402/);
});
