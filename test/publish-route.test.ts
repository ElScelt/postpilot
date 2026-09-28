import test from "node:test";
import assert from "node:assert/strict";
import { handlePublish, type PublishDeps } from "../src/app/api/cron/publish/handler";
import { maxDuration } from "../src/app/api/cron/publish/route";
import { listPosts, updatePost, type QueuedPost } from "../src/lib/storage/posts";
import { publishTimeLimitSeconds } from "../src/lib/scheduling/qstash";
import type { OperatorAlert } from "../src/lib/notify/ntfy";

process.env.APP_URL = "https://example.vercel.app";

function post(overrides: Partial<QueuedPost> = {}): QueuedPost {
  return {
    id: "p1", text: "Draft text.", scheduledFor: "2026-09-07T06:00:00.000Z",
    status: "queued", createdAt: "2026-09-06T18:00:00.000Z", ...overrides,
  };
}

// The real post store over an in-memory value, and a LinkedIn that answers as told.
function fakes(publish: () => Promise<string> = async () => "urn:li:share:1", initial: QueuedPost[] = [post()]) {
  const state = { value: initial as unknown };
  const store = {
    get: async <T,>() => structuredClone(state.value) as T | null,
    set: async (_key: string, value: unknown) => { state.value = structuredClone(value); return "OK"; },
  };
  const calls = { published: [] as string[], alerts: [] as OperatorAlert[] };
  const deps: PublishDeps = {
    listPosts: () => listPosts({ store }),
    updatePost: (updated) => updatePost(updated, { store }),
    publishTextPost: async (text) => { calls.published.push(text); return publish(); },
    notifyOperator: async (alert) => { calls.alerts.push(alert); return true; },
    verifySignature: async (request) => request.headers.get("upstash-signature") === "valid",
  };
  return { deps, calls, read: () => state.value as QueuedPost[] };
}

function delivery(postId = "p1", retried?: number, signature = "valid") {
  const headers: Record<string, string> = { "upstash-signature": signature };
  if (retried !== undefined) headers["upstash-retried"] = String(retried);
  return new Request("https://example.vercel.app/api/cron/publish", { method: "POST", headers, body: JSON.stringify({ postId }) });
}

test("the route's time limit is the one the publish logic assumes", () => {
  assert.equal(maxDuration, publishTimeLimitSeconds);
});

test("refuses a delivery QStash did not sign", async () => {
  const { deps, calls } = fakes();
  assert.equal((await handlePublish(delivery("p1", undefined, "forged"), deps)).status, 401);
  assert.deepEqual(calls.published, []);
});

test("refuses a delivery without a post id", async () => {
  const { deps } = fakes();
  const request = new Request("https://example.vercel.app/api/cron/publish", {
    method: "POST", headers: { "upstash-signature": "valid" }, body: "{}",
  });
  assert.equal((await handlePublish(request, deps)).status, 400);
});

test("a rejected post is left alone", async () => {
  const { deps, calls } = fakes(undefined, [post({ status: "cancelled" })]);
  const response = await handlePublish(delivery(), deps);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).published, false);
  assert.deepEqual(calls.published, []);
});

test("a queued post goes to LinkedIn once and is marked posted", async () => {
  const { deps, calls, read } = fakes();
  const response = await handlePublish(delivery(), deps);
  assert.equal(response.status, 200);
  assert.deepEqual(calls.published, ["Draft text."]);
  assert.equal(read()[0]!.status, "posted");
  assert.equal(read()[0]!.linkedinPostId, "urn:li:share:1");
  assert.ok(read()[0]!.postedAt);
});

test("a LinkedIn refusal keeps the post queued, answers 502 and says QStash will retry", async () => {
  const { deps, calls, read } = fakes(async () => { throw new Error("LinkedIn rejected the post (422): duplicate"); });
  const response = await handlePublish(delivery("p1", 0), deps);
  assert.equal(response.status, 502);
  assert.equal(read()[0]!.status, "queued");
  assert.match(read()[0]!.error!, /422/);
  assert.equal(calls.alerts[0]!.title, "LinkedIn publish failed (attempt 1)");
  assert.equal(calls.alerts[0]!.priority, 3);
  assert.match(calls.alerts[0]!.body, /QStash will retry/);
});

test("the last refusal says QStash has given up, loudly", async () => {
  const { deps, calls } = fakes(async () => { throw new Error("LinkedIn rejected the post (422): duplicate"); });
  await handlePublish(delivery("p1", 3), deps);
  assert.equal(calls.alerts[0]!.title, "LinkedIn publish failed (attempt 4)");
  assert.equal(calls.alerts[0]!.priority, 5);
  assert.match(calls.alerts[0]!.body, /QStash has given up/);
});

test("an authorization failure links to the reconnect page", async () => {
  const { deps, calls } = fakes(async () => { throw new Error("LinkedIn authorization expired. Reconnect LinkedIn."); });
  await handlePublish(delivery(), deps);
  assert.equal(calls.alerts[0]!.link, "https://example.vercel.app/api/auth/linkedin");
});

test("once LinkedIn has the post, a failed bookkeeping write still answers 2xx", async () => {
  const { deps } = fakes();
  deps.updatePost = async () => { throw new Error("fetch failed"); };
  const response = await handlePublish(delivery(), deps);
  assert.equal(response.status, 200, "a 5xx would make QStash publish the text again");
  assert.deepEqual(await response.json(), { published: true, id: "p1", linkedinPostId: "urn:li:share:1", persisted: false });
});
