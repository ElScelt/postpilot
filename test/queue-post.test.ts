import test from "node:test";
import assert from "node:assert/strict";
import { schedulePost } from "../src/lib/queue-post";
import { memoryPostStore } from "./fakes";

process.env.APP_URL = "https://example.vercel.app";

const fakeStore = memoryPostStore;

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

test("a QStash call that hangs marks the post failed instead of running into the route's limit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, read } = fakeStore();
  let called!: () => void;
  const reached = new Promise<void>((resolve) => { called = resolve; });
  const publisher = { publishJSON: () => { called(); return new Promise<never>(() => {}); } };
  const scheduling = schedulePost("text", "2026-09-07T06:00:00.000Z", undefined, { store, publisher: publisher as never });
  await reached;
  t.mock.timers.tick(10_000);
  await assert.rejects(() => scheduling, /QStash did not answer within 10 seconds/);
  assert.equal(read()[0]!.status, "failed");
});
