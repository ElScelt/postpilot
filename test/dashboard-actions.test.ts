import test from "node:test";
import assert from "node:assert/strict";
import { editAction, rejectAction, runNowAction, type ActionDeps } from "../src/app/dashboard/action-handlers";
import type { QueuedPost } from "../src/lib/storage/posts";
import { memoryPostStore } from "./fakes";

process.env.APP_URL = "https://example.vercel.app";

function post(overrides: Partial<QueuedPost> = {}): QueuedPost {
  return {
    id: "a", text: "Original text.", scheduledFor: "2026-09-07T06:00:00.000Z",
    status: "queued", createdAt: "2026-09-06T18:00:00.000Z", ...overrides,
  };
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

function actionDeps(overrides: Partial<ActionDeps> = {}) {
  let revalidated = 0;
  const published: Array<Record<string, unknown>> = [];
  const deps: ActionDeps = {
    authorized: async () => true,
    publisher: () => ({
      publishJSON: async (request: Record<string, unknown>) => { published.push(request); return { messageId: "msg_run" }; },
    }) as never,
    revalidate: () => { revalidated += 1; },
    ...overrides,
  };
  return { deps, published, revalidated: () => revalidated };
}

test("every action refuses a request without the dashboard credential and touches nothing", async () => {
  const { store, read } = memoryPostStore([post()]);
  const { deps, published } = actionDeps({ store, authorized: async () => false });
  await assert.rejects(() => runNowAction(deps), /Not authorized/);
  await assert.rejects(() => rejectAction(form({ id: "a" }), deps), /Not authorized/);
  await assert.rejects(() => editAction(form({ id: "a", text: "Changed." }), deps), /Not authorized/);
  assert.equal(published.length, 0);
  assert.deepEqual(read(), [post()]);
});

test("Run now queues a run with the schedule's retry budget", async () => {
  const { deps, published, revalidated } = actionDeps();
  const result = await runNowAction(deps);
  assert.equal(result.ok, true);
  assert.match(result.message, /msg_run/);
  assert.equal(published[0]!.url, "https://example.vercel.app/api/automation/run");
  assert.equal(published[0]!.retries, 3);
  assert.equal(revalidated(), 1);
});

test("Run now reports a QStash that hangs instead of spinning until the function limit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let called!: () => void;
  const reached = new Promise<void>((resolve) => { called = resolve; });
  const { deps } = actionDeps({ publisher: () => ({ publishJSON: () => { called(); return new Promise<never>(() => {}); } }) as never });
  const running = runNowAction(deps);
  await reached;
  t.mock.timers.tick(10_000);
  assert.deepEqual(await running, { ok: false, message: "The run was not queued: QStash did not answer within 10 seconds." });
});

test("Reject cancels a queued post", async () => {
  const { store, read } = memoryPostStore([post()]);
  const { deps, revalidated } = actionDeps({ store });
  assert.equal((await rejectAction(form({ id: "a" }), deps)).ok, true);
  assert.equal(read()[0]!.status, "cancelled");
  assert.equal(revalidated(), 1);
});

test("Reject and edit say it is too late once the post is publishing, as the review page does", async () => {
  const { store, read } = memoryPostStore([post({ status: "publishing" })]);
  const { deps, revalidated } = actionDeps({ store });
  const tooLate = { ok: false, message: "Too late. This post is being published to LinkedIn right now." };
  assert.deepEqual(await rejectAction(form({ id: "a" }), deps), tooLate);
  assert.deepEqual(await editAction(form({ id: "a", text: "Changed." }), deps), tooLate);
  assert.equal(read()[0]!.status, "publishing");
  assert.equal(read()[0]!.text, "Original text.");
  assert.equal(revalidated(), 2, "the page refreshes to show where the post went");
});

test("Reject of a post that is gone or already handled has nothing to do", async () => {
  const { store } = memoryPostStore([post({ status: "posted" })]);
  const { deps } = actionDeps({ store });
  assert.equal((await rejectAction(form({ id: "a" }), deps)).message, "Nothing to do. This post is already posted.");
  assert.equal((await rejectAction(form({ id: "gone" }), deps)).message, "Nothing to do. That post no longer exists.");
});

test("a Redis failure says the post is unchanged", async () => {
  const { store, read } = memoryPostStore([post()]);
  store.compareAndSet = async () => { throw new Error("Redis unreachable"); };
  const { deps, revalidated } = actionDeps({ store });
  assert.deepEqual(await rejectAction(form({ id: "a" }), deps), { ok: false, message: "Reject failed, the post is still queued: Redis unreachable" });
  assert.deepEqual(await editAction(form({ id: "a", text: "Changed." }), deps), { ok: false, message: "Not saved: Redis unreachable" });
  assert.deepEqual(read(), [post()]);
  assert.equal(revalidated(), 0);
});

test("Edit saves the text and keeps the original", async () => {
  const { store, read } = memoryPostStore([post()]);
  const { deps } = actionDeps({ store });
  assert.equal((await editAction(form({ id: "a", text: "  Changed.  " }), deps)).ok, true);
  assert.equal(read()[0]!.text, "Changed.");
  assert.equal(read()[0]!.originalText, "Original text.");
  assert.deepEqual(await editAction(form({ id: "a", text: "   " }), deps), { ok: false, message: "Not saved: The post text cannot be empty." });
});
