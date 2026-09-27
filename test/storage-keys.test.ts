import test from "node:test";
import assert from "node:assert/strict";
import { loadLinkedInToken, saveLinkedInToken } from "../src/lib/linkedin/api";
import { runScheduleId } from "../src/lib/scheduling/schedules";
import { listPosts, updatePost } from "../src/lib/storage/posts";
import type { KeyValueStore } from "../src/lib/storage/redis";
import { listAutomationRuns, recordAutomationRun } from "../src/lib/storage/runs";

// Every named resource carries the postpilot prefix, so a deployment can never read or
// overwrite another app's data in a shared Redis database or QStash account.
function recordingStore() {
  const keys = new Set<string>();
  const store: KeyValueStore = {
    get: async (key: string) => { keys.add(key); return null; },
    set: async (key: string) => { keys.add(key); return "OK"; },
  } as unknown as KeyValueStore;
  return { store, keys };
}

test("every Redis key and the QStash schedule id start with postpilot", async () => {
  const { store, keys } = recordingStore();
  await listPosts({ store });
  await assert.rejects(() => updatePost({ id: "x", text: "", scheduledFor: "", status: "queued", createdAt: "" }, { store }));
  await listAutomationRuns(store);
  await recordAutomationRun({ ranAt: "2026-09-06T18:00:00.000Z", status: "skipped" }, store);
  await loadLinkedInToken(store);
  await saveLinkedInToken({ accessToken: "t", expiresAt: 0 } as never, store);
  assert.deepEqual([...keys].sort(), ["postpilot:posts", "postpilot:runs", "postpilot:token"]);
  assert.equal(runScheduleId, "postpilot-run");
});
