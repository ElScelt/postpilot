import test from "node:test";
import assert from "node:assert/strict";
import { abandonedPosts, type QueuedPost } from "../src/lib/storage/posts";

const now = new Date("2026-07-29T08:00:00Z");

function post(overrides: Partial<QueuedPost>): QueuedPost {
  return {
    id: "a", text: "t", scheduledFor: "2026-07-28T06:00:00.000Z",
    status: "queued", createdAt: "2026-07-28T05:00:00.000Z", ...overrides,
  };
}

test("retires a post still queued long after its slot", () => {
  const stuck = post({ id: "stuck" });
  assert.deepEqual(abandonedPosts([stuck], now).map((p) => p.id), ["stuck"]);
});

test("leaves a post that may still be in flight", () => {
  const recent = post({ id: "recent", scheduledFor: "2026-07-29T06:00:00.000Z" });
  assert.deepEqual(abandonedPosts([recent], now), []);
});

test("leaves a post scheduled for later today", () => {
  const upcoming = post({ id: "upcoming", scheduledFor: "2026-07-29T09:00:00.000Z" });
  assert.deepEqual(abandonedPosts([upcoming], now), []);
});

test("ignores posts that already reached a terminal state", () => {
  const settled = [
    post({ id: "posted", status: "posted" }),
    post({ id: "cancelled", status: "cancelled" }),
    post({ id: "failed", status: "failed" }),
  ];
  assert.deepEqual(abandonedPosts(settled, now), []);
});
