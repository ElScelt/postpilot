import test from "node:test";
import assert from "node:assert/strict";
import { checkStoredData } from "../scripts/stored-data";

const post = {
  id: "a", text: "Private draft text.", scheduledFor: "2026-09-07T06:00:00.000Z",
  status: "posted", createdAt: "2026-09-06T18:00:00.000Z",
};
const run = { ranAt: "2026-09-06T18:00:00.000Z", status: "scheduled" };
const token = { accessToken: "secret-token", memberId: "member", expiresAt: 1_800_000_000_000 };

test("data this version can read is reported with its statuses and nothing else", () => {
  const [posts, runs, stored] = checkStoredData({ posts: JSON.stringify([post, { ...post, id: "b", status: "queued" }]), runs: [run], token });
  assert.deepEqual(posts, { key: "postpilot:posts", entries: 2, statuses: { posted: 1, queued: 1 }, unknownFields: {}, problems: [], skipped: [] });
  assert.deepEqual(runs!.problems, []);
  assert.deepEqual(stored, { key: "postpilot:token", entries: 1, statuses: {}, unknownFields: {}, problems: [], skipped: [] });
});

test("an old status, a missing field and an unknown field are each named", () => {
  const legacy = { ...post, status: "published", createdAt: undefined, publishedUrl: "https://example.com" };
  const [posts] = checkStoredData({ posts: JSON.stringify([post, legacy]), runs: null, token: null });
  assert.deepEqual(posts!.statuses, { posted: 1, published: 1 });
  assert.deepEqual(posts!.unknownFields, { publishedUrl: 1 });
  assert.equal(posts!.problems.length, 2);
  assert.match(posts!.problems.join("\n"), /^entry 1: status: /m);
  assert.match(posts!.problems.join("\n"), /^entry 1: createdAt: /m);
});

test("a run record this version cannot read is skipped, as the dashboard skips it, not a problem", () => {
  const [, runs] = checkStoredData({ posts: null, runs: [run, { ...run, status: "stopped" }], token: null });
  assert.deepEqual(runs!.problems, []);
  assert.equal(runs!.skipped.length, 1);
  assert.match(runs!.skipped[0]!, /^entry 1: status: /);
});

test("the report never repeats a stored value", () => {
  const broken = { ...token, expiresAt: "secret-expiry" };
  const report = JSON.stringify(checkStoredData({
    posts: JSON.stringify([{ ...post, text: 42 }]), runs: [{ ...run, reason: ["Private reason."] }], token: broken,
  }));
  for (const value of ["Private draft text.", "Private reason.", "secret-token", "secret-expiry"]) {
    assert.ok(!report.includes(value), `the report contains ${value}`);
  }
  assert.match(report, /cannot|expected/);
});

test("a queue that is not JSON, or not a list, is reported rather than thrown", () => {
  assert.deepEqual(checkStoredData({ posts: "{oops", runs: {}, token: null }).map((report) => report.problems), [
    ["not valid JSON"], ["not a list"], [],
  ]);
});

test("nothing stored is nothing to report", () => {
  assert.ok(checkStoredData({ posts: null, runs: null, token: null }).every((report) => report.entries === 0 && !report.problems.length));
});
