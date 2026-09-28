import test from "node:test";
import assert from "node:assert/strict";
import { versionedStore } from "../../src/lib/storage/redis";
import { listPosts } from "../../src/lib/storage/posts";
import { listAutomationRuns, recordAutomationRun } from "../../src/lib/storage/runs";
import { loadLinkedInToken, saveLinkedInToken } from "../../src/lib/linkedin/token";
import { checkStoredData } from "../../scripts/stored-data";
import { testRedis } from "./client";

const client = testRedis();
const raw = versionedStore(testRedis({ automaticDeserialization: false }));
const keys = ["postpilot:posts", "postpilot:runs", "postpilot:token"];

// The real keys, written the way the live bot writes them, then read the way
// npm run check:data and the app read them.
test("data written by the app passes the check and reads back through the schemas", async (t) => {
  const before = await Promise.all(keys.map((key) => client.get(key)));
  t.after(() => Promise.all(keys.map((key, index) => (before[index] === null ? client.del(key) : client.set(key, before[index])))));
  await client.set("postpilot:posts", [{
    id: "a", text: "Post.", scheduledFor: "2026-09-07T06:00:00.000Z", status: "posted", createdAt: "2026-09-06T18:00:00.000Z",
  }]);
  await client.del("postpilot:runs");
  await recordAutomationRun({ ranAt: "2026-09-06T18:00:00.000Z", status: "scheduled", durationMs: 1200 }, raw);
  await saveLinkedInToken({ accessToken: "token", memberId: "member", expiresAt: 1_800_000_000_000 }, client);

  const reports = checkStoredData({
    posts: await raw.getRaw("postpilot:posts"), runs: await client.get("postpilot:runs"), token: await client.get("postpilot:token"),
  });
  assert.deepEqual(reports.map((report) => [report.entries, report.problems]), [[1, []], [1, []], [1, []]]);
  assert.equal((await listPosts({ store: raw }))[0]!.status, "posted");
  assert.equal((await listAutomationRuns(raw))[0]!.durationMs, 1200);
  assert.equal((await loadLinkedInToken(client))!.expiresAt, 1_800_000_000_000);
});
