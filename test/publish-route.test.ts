import test from "node:test";
import assert from "node:assert/strict";
import { handlePublish, type PublishDeps } from "../src/app/api/cron/publish/handler";
import { cancelPost, listPosts, PostNotQueuedError, transitionPost, type QueuedPost } from "../src/lib/storage/posts";
import { publishTextPost } from "../src/lib/linkedin/publish";
import { publishTimeLimitSeconds } from "../src/lib/limits";
import type { OperatorAlert } from "../src/lib/notify/ntfy";
import { memoryPostStore } from "./fakes";

process.env.APP_URL = "https://example.vercel.app";

const start = Date.parse("2026-09-07T06:00:00.000Z");
const day = 86_400_000;

function post(overrides: Partial<QueuedPost> = {}): QueuedPost {
  return {
    id: "p1", text: "Draft text.", scheduledFor: "2026-09-07T06:00:00.000Z",
    status: "queued", createdAt: "2026-09-06T18:00:00.000Z", ...overrides,
  };
}

const accepted = () => new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:1" } });

type Options = {
  // What LinkedIn does with the post request; a throw stands for no answer at all.
  linkedIn?: () => Promise<Response>;
  posts?: QueuedPost[];
  tokenExpiresAt?: number;
};

// The real post store in memory, the real LinkedIn client over a fake LinkedIn, and a
// clock the test moves.
function fakes(options: Options = {}) {
  const { store, read } = memoryPostStore(options.posts ?? [post()]);
  const clock = { now: start };
  const calls = { linkedIn: 0, alerts: [] as OperatorAlert[] };
  const token = { get: async <T,>() => ({ accessToken: "x", memberId: "y", expiresAt: options.tokenExpiresAt ?? Date.now() + 30 * day }) as T };
  const linkedIn: typeof fetch = async () => { calls.linkedIn += 1; return (options.linkedIn ?? (async () => accepted()))(); };
  const deps: PublishDeps = {
    listPosts: () => listPosts({ store }),
    transitionPost: (id, from, patch) => transitionPost(id, from, patch, { store }),
    publishTextPost: (text) => publishTextPost(text, linkedIn, token),
    notifyOperator: async (alert) => { calls.alerts.push(alert); return true; },
    verifySignature: async (request) => request.headers.get("upstash-signature") === "valid",
    clock: () => new Date(clock.now),
  };
  return { deps, calls, read, store, clock };
}

function delivery(retried?: number, signature = "valid") {
  const headers: Record<string, string> = { "upstash-signature": signature };
  if (retried !== undefined) headers["upstash-retried"] = String(retried);
  return new Request("https://example.vercel.app/api/cron/publish", { method: "POST", headers, body: JSON.stringify({ postId: "p1" }) });
}

const timeout = () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

test("refuses a delivery QStash did not sign", async () => {
  const { deps, calls } = fakes();
  assert.equal((await handlePublish(delivery(undefined, "forged"), deps)).status, 401);
  assert.equal(calls.linkedIn, 0);
});

test("refuses a delivery without a post id", async () => {
  const { deps } = fakes();
  const request = new Request("https://example.vercel.app/api/cron/publish", {
    method: "POST", headers: { "upstash-signature": "valid" }, body: "{}",
  });
  assert.equal((await handlePublish(request, deps)).status, 400);
});

test("a rejected post is left alone", async () => {
  const { deps, calls } = fakes({ posts: [post({ status: "cancelled" })] });
  const response = await handlePublish(delivery(), deps);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).published, false);
  assert.equal(calls.linkedIn, 0);
});

test("a queued post goes to LinkedIn once and is marked posted", async () => {
  const { deps, calls, read } = fakes();
  const response = await handlePublish(delivery(), deps);
  assert.equal(response.status, 200);
  assert.equal(calls.linkedIn, 1);
  assert.equal(read()[0]!.status, "posted");
  assert.equal(read()[0]!.linkedinPostId, "urn:li:share:1");
  assert.ok(read()[0]!.postedAt);
});

test("a LinkedIn refusal puts the post back in the queue, answers 502 and says QStash will retry", async () => {
  const { deps, calls, read } = fakes({ linkedIn: async () => new Response("duplicate", { status: 422 }) });
  const response = await handlePublish(delivery(0), deps);
  assert.equal(response.status, 502);
  assert.equal(read()[0]!.status, "queued");
  assert.match(read()[0]!.error!, /422/);
  assert.equal(calls.alerts[0]!.title, "LinkedIn publish failed (attempt 1)");
  assert.equal(calls.alerts[0]!.priority, 3);
  assert.match(calls.alerts[0]!.body, /QStash will retry/);
  assert.equal(calls.alerts[0]!.link, undefined, "a refusal that is not about the authorization offers no reconnect link");
});

test("a refusal of the authorization offers the reconnect link", async () => {
  const { deps, calls } = fakes({ linkedIn: async () => new Response("invalid access token", { status: 401 }) });
  assert.equal((await handlePublish(delivery(0), deps)).status, 502);
  assert.equal(calls.alerts[0]!.link, "https://example.vercel.app/api/auth/linkedin");
});

test("an expired authorization offers the reconnect link without calling LinkedIn", async () => {
  const { deps, calls } = fakes({ tokenExpiresAt: start - day });
  assert.equal((await handlePublish(delivery(0), deps)).status, 502);
  assert.equal(calls.linkedIn, 0);
  assert.equal(calls.alerts[0]!.link, "https://example.vercel.app/api/auth/linkedin");
});

test("LinkedIn being briefly unavailable is retried like a refusal", async () => {
  const { deps, read } = fakes({ linkedIn: async () => new Response("unavailable", { status: 503 }) });
  assert.equal((await handlePublish(delivery(0), deps)).status, 502);
  assert.equal(read()[0]!.status, "queued");
});

test("the last refusal says QStash has given up, loudly", async () => {
  const { deps, calls } = fakes({ linkedIn: async () => new Response("duplicate", { status: 422 }) });
  await handlePublish(delivery(3), deps);
  assert.equal(calls.alerts[0]!.title, "LinkedIn publish failed (attempt 4)");
  assert.equal(calls.alerts[0]!.priority, 5);
  assert.match(calls.alerts[0]!.body, /QStash has given up/);
});

test("an expired authorization links to the reconnect page and sends nothing", async () => {
  const { deps, calls, read } = fakes({ tokenExpiresAt: Date.now() - day });
  assert.equal((await handlePublish(delivery(), deps)).status, 502);
  assert.equal(calls.linkedIn, 0);
  assert.equal(read()[0]!.status, "queued");
  assert.equal(calls.alerts[0]!.link, "https://example.vercel.app/api/auth/linkedin");
});

test("a Reject that lands while LinkedIn is publishing is refused, not reported as done", async () => {
  const { deps, read, store } = fakes();
  let reject: Promise<unknown> | undefined;
  deps.publishTextPost = async () => {
    reject = cancelPost("p1", { store }).catch((error: unknown) => error);
    await reject;
    return "urn:li:share:1";
  };
  await handlePublish(delivery(), deps);
  const refusal = await reject;
  assert.ok(refusal instanceof PostNotQueuedError, "the Reject page must not say Rejected");
  assert.equal(refusal.status, "publishing");
  assert.equal(read()[0]!.status, "posted", "the record says what LinkedIn has");
});

test("a LinkedIn call that times out is never retried, because the post may be live", async () => {
  const { deps, calls, read } = fakes({ linkedIn: timeout });
  const response = await handlePublish(delivery(0), deps);
  assert.equal(response.status, 200, "a non-2xx answer would make QStash publish it again");
  assert.equal(calls.linkedIn, 1);
  assert.equal(read()[0]!.status, "failed");
  assert.match(read()[0]!.error!, /may be live/);
  assert.equal(calls.alerts[0]!.title, "Check LinkedIn: a post may have gone out");
  assert.equal(calls.alerts[0]!.priority, 5);
  assert.equal((await handlePublish(delivery(1), deps)).status, 200);
  assert.equal(calls.linkedIn, 1, "a later delivery finds nothing to publish");
});

test("a server error from LinkedIn is treated as an unknown outcome", async () => {
  const { deps, calls, read } = fakes({ linkedIn: async () => new Response("boom", { status: 500 }) });
  assert.equal((await handlePublish(delivery(0), deps)).status, 200);
  assert.equal(read()[0]!.status, "failed");
  assert.equal(calls.alerts[0]!.title, "Check LinkedIn: a post may have gone out");
});

test("a publish killed mid-call ends failed with an alert, never stuck in publishing", async () => {
  const { deps, calls, read, clock, store } = fakes();
  // The first delivery claimed the post and was killed at the time limit while LinkedIn
  // was answering, so nothing was written after the claim.
  await transitionPost("p1", ["queued"], { status: "publishing", claimedAt: new Date(clock.now).toISOString() }, { store });
  clock.now += publishTimeLimitSeconds * 1000 + 12_000;
  const first = await handlePublish(delivery(0), deps);
  assert.equal(first.status, 503, "too soon to be sure the first delivery is dead, so QStash must come back");
  assert.equal(read()[0]!.status, "publishing");
  clock.now += 148_000;
  const second = await handlePublish(delivery(1), deps);
  assert.equal(second.status, 200);
  assert.equal(calls.linkedIn, 0, "a post that may be live is never sent again");
  assert.equal(read()[0]!.status, "failed");
  assert.deepEqual(calls.alerts.map((alert) => alert.title), ["Check LinkedIn: a post may have gone out"]);
});

test("the last delivery alerts about a recent claim instead of asking for a retry", async () => {
  const { deps, calls, read, clock } = fakes({ posts: [post({ status: "publishing", claimedAt: new Date(start).toISOString() })] });
  clock.now += 30_000;
  const response = await handlePublish(delivery(3), deps);
  assert.equal(response.status, 200);
  assert.equal(calls.linkedIn, 0);
  assert.equal(read()[0]!.status, "failed");
  assert.equal(calls.alerts[0]!.title, "Check LinkedIn: a post may have gone out");
});

test("once LinkedIn has the post, a failed record write is retried once", async () => {
  const { deps, read } = fakes();
  const write = deps.transitionPost;
  let finishes = 0;
  deps.transitionPost = async (id, from, patch) => {
    if (patch.status === "posted" && (finishes += 1) === 1) throw new Error("fetch failed");
    return write(id, from, patch);
  };
  const response = await handlePublish(delivery(), deps);
  assert.equal(response.status, 200);
  assert.equal(read()[0]!.status, "posted");
});

test("when the record still cannot be written, the alert says LinkedIn has the post", async () => {
  const { deps, calls } = fakes();
  const write = deps.transitionPost;
  deps.transitionPost = async (id, from, patch) => {
    if (patch.status === "posted") throw new Error("fetch failed");
    return write(id, from, patch);
  };
  const response = await handlePublish(delivery(), deps);
  assert.equal(response.status, 200, "a 5xx would make QStash publish the text again");
  assert.deepEqual(await response.json(), { published: true, id: "p1", linkedinPostId: "urn:li:share:1", persisted: false });
  assert.equal(calls.alerts[0]!.title, "LinkedIn published the post, but its record was not updated");
  assert.match(calls.alerts[0]!.body, /urn:li:share:1/);
});
