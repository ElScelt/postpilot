import test from "node:test";
import assert from "node:assert/strict";
import { addPost, cancelPost, editPostText, PostNotQueuedError, retainPosts, schedulePost, transitionPost, type QueuedPost } from "../src/lib/storage/posts";
import { memoryPostStore } from "./fakes";

process.env.APP_URL = "https://example.vercel.app";

const fakeStore = memoryPostStore;

function post(overrides: Partial<QueuedPost>): QueuedPost {
  return {
    id: "a", text: "t", scheduledFor: "2026-09-07T06:00:00.000Z",
    status: "queued", createdAt: "2026-09-06T18:00:00.000Z", ...overrides,
  };
}

test("schedules a delivery with a deduplication id and stores the message id", async () => {
  const { store, read } = fakeStore();
  const publishes: Array<Record<string, unknown>> = [];
  const publisher = { publishJSON: async (request: Record<string, unknown>) => { publishes.push(request); return { messageId: "msg_1" }; } };
  const scheduled = await schedulePost("text", "2026-09-07T06:00:00.000Z", undefined, { store, publisher: publisher as never });
  assert.equal(publishes[0]!.deduplicationId, scheduled.id);
  assert.equal(publishes[0]!.url, "https://example.vercel.app/api/cron/publish");
  assert.equal(read()[0]!.qstashMessageId, "msg_1");
});

test("marks the post failed and rethrows when QStash refuses the delivery", async () => {
  const { store, read } = fakeStore();
  const publisher = { publishJSON: async () => { throw new Error("QStash 402"); } };
  await assert.rejects(() => schedulePost("text", "2026-09-07T06:00:00.000Z", undefined, { store, publisher: publisher as never }), /QStash 402/);
  assert.equal(read()[0]!.status, "failed");
  assert.equal(read()[0]!.error, "QStash 402");
});

test("refuses a second post for the same UTC day", async () => {
  const { store } = fakeStore([post({})]);
  await assert.rejects(() => addPost("again", "2026-09-07T08:00:00.000Z", undefined, { store }), /already queued for that UTC day/);
  await assert.doesNotReject(() => addPost("tomorrow", "2026-09-08T06:00:00.000Z", undefined, { store }));
});

test("cancels only a queued post, and only once", async () => {
  const { store, read } = fakeStore([post({})]);
  await cancelPost("a", { store });
  assert.equal(read()[0]!.status, "cancelled");
  await assert.rejects(() => cancelPost("a", { store }), /No queued post/);
});

test("refusing a post that is not queued says which state it is in", async () => {
  const { store } = fakeStore([post({ status: "posted" })]);
  await assert.rejects(() => cancelPost("a", { store }), (error) =>
    error instanceof PostNotQueuedError && error.id === "a" && error.status === "posted");
  await assert.rejects(() => cancelPost("gone", { store }), (error) =>
    error instanceof PostNotQueuedError && error.status === undefined);
});

test("changing an unknown post fails loudly", async () => {
  const { store } = fakeStore([]);
  await assert.rejects(() => transitionPost("ghost", ["posted"], { error: "x" }, { store }), /no longer stored/);
});

test("a change is refused when the post has left the states it needs", async () => {
  const { store, read } = fakeStore([post({ status: "cancelled" })]);
  await assert.rejects(() => transitionPost("a", ["queued"], { status: "posted" }, { store }), PostNotQueuedError);
  assert.equal(read()[0]!.status, "cancelled");
});

test("a write that keeps losing to other writers gives up without writing", async () => {
  const shared = fakeStore([post({})]);
  shared.alwaysConflict();
  await assert.rejects(() => cancelPost("a", { store: shared.store }), /kept changing/);
  assert.equal(shared.read()[0]!.status, "queued");
});

test("keeps every queued post and only the newest terminal ones", () => {
  const terminal = Array.from({ length: 250 }, (_, index) => post({
    id: `t${index}`, status: "posted", scheduledFor: `2025-${String(1 + (index % 12)).padStart(2, "0")}-${String(1 + (index % 28)).padStart(2, "0")}T06:00:00.000Z`,
  }));
  const queued = post({ id: "q", scheduledFor: "2024-01-01T06:00:00.000Z" });
  const kept = retainPosts([...terminal, queued]);
  assert.equal(kept.length, 201);
  assert.ok(kept.some((entry) => entry.id === "q"), "an old queued post is never trimmed");
});

test("the owner can rewrite a queued post, and the original is kept", async () => {
  const { store, read } = fakeStore([post({})]);
  await editPostText("a", "  My own words.  ", { store });
  assert.equal(read()[0]!.text, "My own words.");
  assert.equal(read()[0]!.originalText, "t");
  assert.ok(read()[0]!.editedAt);
  await editPostText("a", "Second pass.", { store });
  assert.equal(read()[0]!.originalText, "t", "the original survives a second edit");
  await assert.rejects(() => editPostText("a", "   ", { store }), /cannot be empty/);
  await assert.rejects(() => editPostText("a", "x".repeat(3001), { store }), /exceeds 3000/);
});

test("a published post can no longer be edited", async () => {
  const { store } = fakeStore([post({ status: "posted" })]);
  await assert.rejects(() => editPostText("a", "too late", { store }), /No queued post/);
});

test("an edit and a Reject that land together both survive", async () => {
  const shared = memoryPostStore([post({ id: "a" }), post({ id: "b", scheduledFor: "2026-09-08T06:00:00.000Z" })]);
  // The Reject of b completes between the edit's read of the queue and its write.
  shared.onNextWrite(async () => { await cancelPost("b", { store: shared.store }); });
  await editPostText("a", "Edited.", { store: shared.store });
  const [a, b] = shared.read();
  assert.equal(a!.text, "Edited.");
  assert.equal(b!.status, "cancelled", "the edit must not write back its stale copy of b");
});

test("a post on its way to LinkedIn is kept and blocks a second post for its day", async () => {
  const terminal = Array.from({ length: 210 }, (_, index) => post({ id: `t${index}`, status: "posted", scheduledFor: "2030-01-01T06:00:00.000Z" }));
  const publishing = post({ id: "p", status: "publishing", scheduledFor: "2020-01-01T06:00:00.000Z" });
  assert.ok(retainPosts([...terminal, publishing]).some((entry) => entry.id === "p"));
  const { store } = fakeStore([post({ status: "publishing" })]);
  await assert.rejects(() => addPost("again", "2026-09-07T08:00:00.000Z", undefined, { store }), /already queued/);
});
