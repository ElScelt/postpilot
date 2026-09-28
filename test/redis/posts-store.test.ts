import test from "node:test";
import assert from "node:assert/strict";
import { versionedStore } from "../../src/lib/storage/redis";
import { cancelPost, editPostText, listPosts, type QueuedPost } from "../../src/lib/storage/posts";
import { testRedis } from "./client";

const client = testRedis();
const raw = versionedStore(testRedis({ automaticDeserialization: false }));

function post(id: string, scheduledFor: string): QueuedPost {
  return { id, text: `Post ${id}.`, scheduledFor, status: "queued", createdAt: "2026-09-06T18:00:00.000Z" };
}

test("a write lands only while the key still holds what the writer read", async (t) => {
  const key = `postpilot:test:cas:${crypto.randomUUID()}`;
  t.after(() => client.del(key));
  assert.equal(await raw.getRaw(key), null);
  assert.equal(await raw.compareAndSet(key, "", "[1]"), true, "a missing key counts as empty");
  assert.equal(await raw.compareAndSet(key, "", "[2]"), false, "a write based on a stale read is refused");
  assert.equal(await raw.getRaw(key), "[1]");
  assert.equal(await raw.compareAndSet(key, "[1]", "[3]"), true);
  assert.equal(await raw.getRaw(key), "[3]");
});

// postpilot:posts itself, so the queue the live bot already holds is what gets read.
test("the queue written the old way is read, changed and still readable the old way", async (t) => {
  const key = "postpilot:posts";
  const before = await client.get(key);
  t.after(async () => { if (before === null) await client.del(key); else await client.set(key, before); });
  // Before compare-and-set, the queue was written with the deserialising client's set.
  await client.set(key, [post("a", "2026-09-07T06:00:00.000Z"), post("b", "2026-09-08T06:00:00.000Z")]);
  await editPostText("a", "Edited.", { store: raw });
  await cancelPost("b", { store: raw });
  const [a, b] = await listPosts({ store: raw });
  assert.equal(a!.text, "Edited.");
  assert.equal(b!.status, "cancelled");
  const oldReader = await client.get<QueuedPost[]>(key);
  assert.equal(oldReader?.[1]?.status, "cancelled", "code before this change still reads the queue");
});
