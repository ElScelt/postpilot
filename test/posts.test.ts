import test from "node:test";
import assert from "node:assert/strict";
import { addPost, cancelPost, editPostText, PostNotQueuedError, retainPosts, schedulePost, updatePost, type QueuedPost } from "../src/lib/storage/posts";

process.env.APP_URL = "https://example.vercel.app";

function fakeStore(initial: QueuedPost[] = []) {
  const state = { value: initial as unknown };
  return {
    store: {
      get: async <T,>() => state.value as T | null,
      set: async (_key: string, value: unknown) => { state.value = value; return "OK"; },
    },
    read: () => state.value as QueuedPost[],
  };
}

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

test("updating an unknown post fails loudly", async () => {
  const { store } = fakeStore([]);
  await assert.rejects(() => updatePost(post({ id: "ghost" }), { store }), /no longer exists/);
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
