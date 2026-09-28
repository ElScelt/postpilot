import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { handleReject, handleReviewPage, type RejectDeps } from "../src/app/api/posts/reject/handler";
import { cancelPost, listPosts, type QueuedPost } from "../src/lib/storage/posts";
import { rejectToken } from "../src/lib/security/reject-token";

process.env.AUTOMATION_SECRET = "reject-secret";

function post(overrides: Partial<QueuedPost> = {}): QueuedPost {
  return {
    id: "p1", text: "Draft text.", scheduledFor: "2026-09-07T06:00:00.000Z",
    status: "queued", createdAt: "2026-09-06T18:00:00.000Z", ...overrides,
  };
}

// The real post store over an in-memory value, so the handler runs the real cancel logic.
function fakes(initial: QueuedPost[] = [post()]) {
  const state = { value: initial as unknown };
  const store = {
    get: async <T,>() => state.value as T | null,
    set: async (_key: string, value: unknown) => { state.value = value; return "OK"; },
  };
  const deps: RejectDeps = {
    listPosts: () => listPosts({ store }),
    cancelPost: (id) => cancelPost(id, { store }),
  };
  return { deps, read: () => state.value as QueuedPost[] };
}

function reviewRequest(id: string, method: "GET" | "POST", token = rejectToken(id)) {
  return new NextRequest(`https://example.vercel.app/api/posts/reject?id=${id}&token=${token}`, { method });
}

test("a link with a wrong signature shows the invalid-link page and cancels nothing", async () => {
  const { deps, read } = fakes();
  const response = await handleReject(reviewRequest("p1", "POST", "0".repeat(64)), deps);
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
