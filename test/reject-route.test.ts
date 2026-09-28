import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { handleReject, handleReviewPage, type RejectDeps } from "../src/app/api/posts/reject/handler";
import { cancelPost, listPosts, type QueuedPost } from "../src/lib/storage/posts";
import { rejectToken } from "../src/lib/security/reject-token";
import { memoryPostStore } from "./fakes";

process.env.AUTOMATION_SECRET = "reject-secret";

function post(overrides: Partial<QueuedPost> = {}): QueuedPost {
  return {
    id: "p1", text: "Draft text.", scheduledFor: "2026-09-07T06:00:00.000Z",
    status: "queued", createdAt: "2026-09-06T18:00:00.000Z", ...overrides,
  };
}

// The real post store over an in-memory value, so the handler runs the real cancel logic.
function fakes(initial: QueuedPost[] = [post()]) {
  const { store, read } = memoryPostStore(initial);
  const deps: RejectDeps = {
    listPosts: () => listPosts({ store }),
    cancelPost: (id) => cancelPost(id, { store }),
  };
  return { deps, read };
}

function reviewRequest(id: string, method: "GET" | "POST", token = rejectToken(id)) {
  return new NextRequest(`https://example.vercel.app/api/posts/reject?id=${id}&token=${token}`, { method });
}

test("a link with a wrong signature shows the invalid-link page and cancels nothing", async () => {
  const { deps, read } = fakes();
  const response = await handleReject(reviewRequest("p1", "POST", "0".repeat(64)), deps);
  assert.equal(response.status, 403, "the ntfy button must not report success");
  assert.match(await response.text(), /Invalid or expired link/);
  assert.equal(read()[0]!.status, "queued");
});

test("opening the review page never cancels the post", async () => {
  const { deps, read } = fakes();
  const response = await handleReviewPage(reviewRequest("p1", "GET"), deps);
  const html = await response.text();
  assert.match(html, /Draft text\./);
  assert.match(html, /<form method="post"/);
  assert.equal(read()[0]!.status, "queued");
});

test("the review page shows when the post publishes, its theme and topic, and its sources", async () => {
  const { deps } = fakes([post({
    automation: {
      theme: "ai-integration", topic: "Streaming responses",
      sources: [{ title: "Streaming in Next.js", url: "https://nextjs.org/blog/streaming", publishedDate: "2026-09-01", primary: true }],
    },
  })]);
  const html = await (await handleReviewPage(reviewRequest("p1", "GET"), deps)).text();
  assert.match(html, /<h1>Publishes Mon 07 Sept?, 06:00<\/h1>/);
  assert.match(html, /ai-integration · Streaming responses/);
  assert.match(html, /<a href="https:\/\/nextjs\.org\/blog\/streaming" rel="noreferrer">Streaming in Next\.js<\/a> \(2026-09-01\)/);
});

test("the review page escapes the draft and its sources, which come from the model and the web", async () => {
  const { deps } = fakes([post({
    text: `Use <script>alert("x")</script> & 'quotes'.`,
    automation: {
      topic: "<img src=x onerror=alert(1)>",
      sources: [{ title: "</a><script>", url: `https://example.com/"onmouseover="alert(1)`, publishedDate: "2026-09-01", primary: false }],
    },
  })]);
  const html = await (await handleReviewPage(reviewRequest("p1", "GET"), deps)).text();
  assert.doesNotMatch(html, /<script>|<img|"onmouseover/);
  assert.match(html, /Use &#60;script&#62;alert\(&#34;x&#34;\)&#60;\/script&#62; &#38; &#39;quotes&#39;\./);
  assert.match(html, /&#60;img src=x onerror=alert\(1\)&#62;/);
});

test("Reject cancels a queued post", async () => {
  const { deps, read } = fakes();
  const response = await handleReject(reviewRequest("p1", "POST"), deps);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<h1>Rejected<\/h1>/);
  assert.equal(read()[0]!.status, "cancelled");
});

test("a second Reject says there is nothing to do", async () => {
  const { deps } = fakes([post({ status: "cancelled" })]);
  const response = await handleReject(reviewRequest("p1", "POST"), deps);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Nothing to do/);
});

test("a Reject that could not reach storage says it failed and offers another try", async () => {
  const { deps } = fakes();
  deps.cancelPost = async () => { throw new Error("fetch failed"); };
  const response = await handleReject(reviewRequest("p1", "POST"), deps);
  assert.equal(response.status, 500, "the ntfy http action must see the failure");
  const html = await response.text();
  assert.match(html, /Reject failed/);
  assert.match(html, /<form method="post" action="\/api\/posts\/reject\?id=p1&#38;token=/, "one tap retries");
  assert.doesNotMatch(html, /Nothing to do/);
});

test("a post that is no longer queued is named by its status", async () => {
  const { deps } = fakes([post({ status: "posted" })]);
  const response = await handleReject(reviewRequest("p1", "POST"), deps);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /already posted\./);
});

test("a post the history no longer holds is reported as gone", async () => {
  const { deps } = fakes([]);
  const response = await handleReject(reviewRequest("p1", "POST"), deps);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /no longer exists/);
});

test("a post being published is too late to reject, and the page says so", async () => {
  const { deps } = fakes([post({ status: "publishing" })]);
  const html = await (await handleReject(reviewRequest("p1", "POST"), deps)).text();
  assert.match(html, /Too late/);
  const review = await (await handleReviewPage(reviewRequest("p1", "GET"), deps)).text();
  assert.match(review, /being published/);
  assert.doesNotMatch(review, /<form/, "no Reject button for a post already on its way");
});

test("a review page that cannot load the draft says so and offers Reject anyway", async () => {
  const { deps } = fakes();
  deps.listPosts = async () => { throw new Error("fetch failed"); };
  const response = await handleReviewPage(reviewRequest("p1", "GET"), deps);
  assert.equal(response.status, 500);
  const html = await response.text();
  assert.match(html, /could not be loaded/);
  assert.match(html, /<form method="post"/, "rejecting must not depend on reading the draft first");
});
