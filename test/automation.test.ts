import test from "node:test";
import assert from "node:assert/strict";
import { recentActivity, runAutomation, type AutomationDeps } from "../src/lib/automation";
import type { AutomationRun } from "../src/lib/storage/runs";
import { DraftRejectedError, draftingBudgetMs, type DraftOutcome } from "../src/lib/drafting/pipeline";
import { runTimeLimitSeconds } from "../src/lib/limits";
import type { RecentActivity } from "../src/lib/drafting/prompt";
import type { TokenStatus } from "../src/lib/linkedin/token";
import type { QueuedPost } from "../src/lib/storage/posts";

process.env.APP_URL = "https://example.vercel.app";
process.env.NTFY_TOPIC = "secret-topic";

// Sunday 18:00 UTC; with the default configuration the post targets Monday 09:00 UTC.
const now = new Date("2026-09-06T18:00:00.000Z");
const day = 86_400_000;
const valid: TokenStatus = { state: "valid", daysRemaining: 40 };

function post(overrides: Partial<QueuedPost>): QueuedPost {
  return {
    id: "old", text: "An older post.\n\nBody.\n\nWhich one first?", scheduledFor: "2026-09-04T06:00:00.000Z",
    status: "posted", createdAt: "2026-09-03T18:00:00.000Z",
    automation: { topic: "Older topic", theme: "backend", sources: [] },
    ...overrides,
  };
}

const scheduledOutcome: DraftOutcome = {
  decision: {
    shouldPost: true, reason: "fresh", topic: "Streaming UI", theme: "frontend",
    text: "Hook.\n\nBody.\n\nWhich would you stream first?",
    sources: [{ title: "Next.js", url: "https://nextjs.org/blog/x", publishedDate: "2026-09-05", primary: true }],
  },
  theme: "frontend", themesTried: ["frontend"], evidenceHosts: { frontend: ["nextjs.org"] }, attempts: [],
};

type Options = {
  posts?: QueuedPost[];
  token?: TokenStatus;
  tokenAtPublish?: TokenStatus;
  outcome?: DraftOutcome;
  draftError?: Error;
  reconcile?: AutomationDeps["reconcileAutomationSchedules"];
  locked?: boolean;
  // The notice cannot reach ntfy.
  noticeFails?: boolean;
};

function fakes(options: Options = {}) {
  const calls = {
    scheduled: [] as string[], runs: [] as AutomationRun[], alerts: [] as string[],
    updates: [] as QueuedPost[], notified: 0, drafted: [] as RecentActivity[], released: false, delivered: [] as string[],
  };
  const deps: AutomationDeps = {
    listPosts: async () => options.posts ?? [],
    transitionPost: async (id, _from, patch) => {
      const updated = { ...post({ id }), ...patch } as QueuedPost;
      calls.updates.push(updated);
      return updated;
    },
    schedulePost: async (text, scheduledFor, automation) => {
      calls.scheduled.push(text);
      return { id: "new", text, scheduledFor, status: "queued", createdAt: now.toISOString(), automation, qstashMessageId: "msg_new" };
    },
    scheduleDelivery: async (stored) => {
      calls.delivered.push(stored.id);
      return { ...stored, qstashMessageId: "msg_resumed" };
    },
    linkedInTokenStatus: async (at = Date.now()) => (at > now.getTime() + 60_000 ? options.tokenAtPublish ?? options.token ?? valid : options.token ?? valid),
    generateGroundedDraft: async (recent) => {
      calls.drafted.push(recent);
      if (options.draftError) throw options.draftError;
      return options.outcome ?? scheduledOutcome;
    },
    reconcileAutomationSchedules: options.reconcile ?? (async () => []),
    notifyDraftQueued: async () => { calls.notified += 1; return !options.noticeFails; },
    notifyOperator: async (alert) => { calls.alerts.push(alert.title); return true; },
    recordAutomationRun: async (run) => { calls.runs.push(run); return run; },
    acquireRunLock: async () => (options.locked ? undefined : "token"),
    releaseRunLock: async () => { calls.released = true; },
  };
  return { deps, calls };
}

test("drafts, schedules and notifies on a normal night", async () => {
  const { deps, calls } = fakes();
  const result = await runAutomation(now, deps);
  assert.equal(result.status, "scheduled");
  assert.deepEqual(calls.scheduled, [scheduledOutcome.decision.shouldPost ? scheduledOutcome.decision.text : ""]);
  assert.equal(calls.notified, 1);
  assert.equal(calls.runs[0]!.status, "scheduled");
  assert.equal(calls.runs[0]!.theme, "frontend");
  assert.deepEqual(calls.runs[0]!.evidenceHosts, { frontend: ["nextjs.org"] });
  assert.equal(calls.runs[0]!.scheduledFor, "2026-09-07T09:00:00.000Z");
  assert.deepEqual(calls.alerts, []);
  assert.equal(calls.released, true);
});

test("skips drafting when a post for tomorrow's slot already exists", async () => {
  const { deps, calls } = fakes({ posts: [post({
    id: "queued", status: "queued", scheduledFor: "2026-09-07T06:00:00.000Z", qstashMessageId: "msg", notifiedAt: "2026-09-06T18:01:00.000Z",
  })] });
  const result = await runAutomation(now, deps);
  assert.equal(result.status, "skipped");
  assert.match(result.status === "skipped" ? result.reason : "", /already created post queued/);
  assert.equal(calls.drafted.length, 0);
  assert.equal(calls.scheduled.length, 0);
});

test("a post being published for tomorrow's slot also counts as tomorrow's post", async () => {
  const { deps, calls } = fakes({ posts: [post({ id: "going", status: "publishing", scheduledFor: "2026-09-07T06:00:00.000Z" })] });
  const result = await runAutomation(now, deps);
  assert.equal(result.status, "skipped");
  assert.equal(calls.drafted.length, 0);
});

test("still drafts when schedule reconciliation throws", async () => {
  const { deps, calls } = fakes({ reconcile: async () => { throw new Error("QStash 500"); } });
  const result = await runAutomation(now, deps);
  assert.equal(result.status, "scheduled");
  assert.match(calls.runs[0]!.warning!, /Schedule reconciliation failed: QStash 500/);
});

test("retires an abandoned post, alerts, and stops on an expired token", async () => {
  const { deps, calls } = fakes({
    posts: [post({ id: "stuck", status: "queued", scheduledFor: "2026-09-01T06:00:00.000Z" })],
    token: { state: "expired", daysRemaining: -3 },
  });
  const result = await runAutomation(now, deps);
  assert.equal(result.status, "stopped");
  assert.match(result.status === "stopped" ? result.reason : "", /expired 3 days ago/);
  assert.equal(calls.updates[0]!.status, "failed");
  assert.ok(calls.alerts.includes("A LinkedIn post never went out"));
  assert.ok(calls.alerts.includes("LinkedIn posting is stopped"));
  assert.equal(calls.drafted.length, 0);
  assert.equal(calls.runs[0]!.status, "failed");
  assert.match(calls.runs[0]!.warning!, /Earlier post stuck never published/);
});

test("a post stuck mid-publish is retired with a check-LinkedIn alert and never sent again", async () => {
  const { deps, calls } = fakes({
    posts: [post({ id: "stuck", status: "publishing", scheduledFor: "2026-09-06T06:00:00.000Z", claimedAt: "2026-09-06T06:00:05.000Z" })],
  });
  const froms: string[][] = [];
  const record = deps.transitionPost;
  deps.transitionPost = async (id, from, patch) => {
    if (id === "stuck") froms.push(from);
    return record(id, from, patch);
  };
  await runAutomation(now, deps);
  assert.deepEqual(froms, [["publishing"]]);
  assert.equal(calls.updates[0]!.status, "failed");
  assert.match(calls.updates[0]!.error!, /may be live/);
  assert.ok(calls.alerts.includes("A LinkedIn post may or may not have gone out"));
  assert.ok(!calls.alerts.includes("A LinkedIn post never went out"));
});

test("queues the post but demands a reconnect when the token dies before the publish", async () => {
  const { deps, calls } = fakes({ token: { state: "valid", daysRemaining: 0 }, tokenAtPublish: { state: "expired", daysRemaining: 0 } });
  const result = await runAutomation(now, deps);
  assert.equal(result.status, "scheduled");
  assert.ok(calls.alerts.includes("Reconnect LinkedIn tonight"));
  assert.match(calls.runs[0]!.warning!, /expires before the .* publish/);
});

test("nags from ten days before the authorization expires", async () => {
  const { deps, calls } = fakes({ token: { state: "valid", daysRemaining: 9 } });
  await runAutomation(now, deps);
  assert.ok(calls.alerts.includes("LinkedIn authorization expires in 9 days"));
});

test("refuses to run while another run holds the lock for the same morning", async () => {
  const { deps, calls } = fakes({ locked: true });
  const lockKeys: string[] = [];
  deps.acquireRunLock = async (key) => { lockKeys.push(key); return undefined; };
  const result = await runAutomation(now, deps);
  assert.deepEqual(lockKeys, ["postpilot:run-lock:2026-09-07"]);
  assert.equal(result.status, "busy");
  assert.match(result.reason, /already in progress/);
  assert.equal(calls.drafted.length, 0);
  assert.deepEqual(calls.runs, [], "a run that never started is not recorded");
});

test("a run killed while holding the lock does not block QStash's first retry", async () => {
  // A lock that expires the way Redis's does, and a release that never happens, as when
  // the platform kills the function at maxDuration.
  let clock = now.getTime();
  let heldUntil = 0;
  const { deps } = fakes();
  deps.acquireRunLock = async (_key, ttlSeconds) => {
    if (clock < heldUntil) return undefined;
    heldUntil = clock + ttlSeconds * 1000;
    return "token";
  };
  deps.releaseRunLock = async () => {};
  await runAutomation(now, deps);
  // Killed at the time limit; QStash's first retry follows about twelve seconds later.
  clock += 300_000 + 12_000;
  const retry = await runAutomation(new Date(clock), deps);
  assert.equal(retry.status, "scheduled");
});

test("drafting ends in time for the run to queue the post before the route's limit", async () => {
  const { deps } = fakes();
  let deadline: number | undefined;
  deps.generateGroundedDraft = async (_recent, options) => {
    deadline = options?.deadline;
    return scheduledOutcome;
  };
  await runAutomation(now, deps);
  assert.equal(deadline, now.getTime() + draftingBudgetMs);
  assert.ok(draftingBudgetMs < runTimeLimitSeconds * 1000);
});

test("records a rejected draft with its attempts, alerts on the final attempt, and rethrows", async () => {
  const error = new DraftRejectedError("Draft contains an em-dash.", [{ text: "bad —", reason: "Draft contains an em-dash." }], "frontend");
  const { deps, calls } = fakes({ draftError: error });
  await assert.rejects(() => runAutomation(now, deps), error);
  assert.equal(calls.runs[0]!.status, "failed");
  assert.equal(calls.runs[0]!.attempts?.length, 1);
  assert.equal(calls.runs[0]!.theme, "frontend");
  assert.ok(calls.alerts.includes("No LinkedIn post tonight: the draft failed validation"));
  assert.equal(calls.released, true);
});

test("stays quiet about a rejected draft while QStash still has retries", async () => {
  const error = new DraftRejectedError("bad", [], "frontend");
  const { deps, calls } = fakes({ draftError: error });
  await assert.rejects(() => runAutomation(now, deps, { finalAttempt: false }), error);
  assert.deepEqual(calls.alerts, []);
});

test("a skipped night is recorded with the themes tried and pushed at low priority", async () => {
  const { deps, calls } = fakes({
    outcome: { decision: { shouldPost: false, reason: "No dated recent evidence found (tried frontend, backend)." }, themesTried: ["frontend", "backend"], evidenceHosts: { frontend: [], backend: [] }, attempts: [] },
  });
  const result = await runAutomation(now, deps);
  assert.equal(result.status, "skipped");
  assert.deepEqual(calls.runs[0]!.themesTried, ["frontend", "backend"]);
  assert.ok(calls.alerts.includes("No LinkedIn post tonight"));
  assert.equal(calls.scheduled.length, 0);
});

test("records when the notice reached ntfy", async () => {
  const { deps, calls } = fakes();
  await runAutomation(now, deps);
  assert.ok(calls.updates.some((update) => update.id === "new" && update.notifiedAt));
});

test("a notice that cannot be delivered fails the run while QStash has retries, and the post stays queued", async () => {
  const { deps, calls } = fakes({ noticeFails: true });
  await assert.rejects(() => runAutomation(now, deps, { finalAttempt: false }), /could not be delivered; QStash retries the run/);
  assert.equal(calls.scheduled.length, 1);
  assert.ok(!calls.updates.some((update) => update.status === "failed"), "the post waits for the retry to announce it");
  assert.equal(calls.released, true);
});

test("on the last attempt an undeliverable notice withdraws the post, so it never publishes unreviewed", async () => {
  const { deps, calls } = fakes({ noticeFails: true });
  await assert.rejects(() => runAutomation(now, deps, { finalAttempt: true }), /was withdrawn and will not publish/);
  const withdrawn = calls.updates.find((update) => update.id === "new" && update.status === "failed");
  assert.match(withdrawn?.error ?? "", /review notice could not be delivered/);
});

test("a retry that finds tonight's post stored but never announced sends the notice instead of drafting again", async () => {
  const stored = post({ id: "stored", status: "queued", scheduledFor: "2026-09-07T09:00:00.000Z", qstashMessageId: "msg" });
  const { deps, calls } = fakes({ posts: [stored] });
  const result = await runAutomation(now, deps);
  assert.equal(result.status, "scheduled");
  assert.equal(result.status === "scheduled" ? result.id : "", "stored");
  assert.equal(calls.drafted.length, 0);
  assert.deepEqual(calls.delivered, [], "its delivery was already scheduled");
  assert.equal(calls.notified, 1);
  assert.equal(calls.runs[0]!.status, "scheduled");
  assert.match(calls.runs[0]!.warning!, /stored but did not announce/);
});

test("a retry that finds tonight's post stored but never scheduled schedules and announces it", async () => {
  const stored = post({ id: "stored", status: "queued", scheduledFor: "2026-09-07T09:00:00.000Z" });
  const { deps, calls } = fakes({ posts: [stored] });
  const result = await runAutomation(now, deps);
  assert.equal(result.status, "scheduled");
  assert.deepEqual(calls.delivered, ["stored"]);
  assert.equal(calls.notified, 1);
  assert.equal(calls.drafted.length, 0);
  assert.match(calls.runs[0]!.warning!, /stored but did not schedule/);
});

test("a missing notification topic is a warning, never a lost post", async (t) => {
  delete process.env.NTFY_TOPIC;
  t.after(() => { process.env.NTFY_TOPIC = "secret-topic"; });
  const { deps, calls } = fakes();
  const result = await runAutomation(now, deps);
  assert.equal(result.status, "scheduled");
  assert.equal(calls.notified, 0);
  assert.match(calls.runs[0]!.warning!, /NTFY_TOPIC is unset/);
});

test("without a notification topic a scheduled post counts as finished", async (t) => {
  delete process.env.NTFY_TOPIC;
  t.after(() => { process.env.NTFY_TOPIC = "secret-topic"; });
  const { deps, calls } = fakes({ posts: [post({ id: "queued", status: "queued", scheduledFor: "2026-09-07T09:00:00.000Z", qstashMessageId: "msg" })] });
  assert.equal((await runAutomation(now, deps)).status, "skipped");
  assert.equal(calls.notified, 0);
});

test("rejected drafts still count for the rotation and are named as rejected stories", () => {
  const published = post({ id: "p", automation: { topic: "Server actions", theme: "frontend", sources: [{ title: "a", url: "https://react.dev/a", publishedDate: "2026-09-01", primary: true }] } });
  const rejected = post({
    id: "v", status: "cancelled", text: "Rejected hook.\n\nBody.\n\nRejected question?", createdAt: new Date(now.getTime() - day).toISOString(),
    automation: { topic: "Edge caching bill shock", theme: "platform", sources: [{ title: "b", url: "https://vercel.com/b", publishedDate: "2026-09-04", primary: true }] },
  });
  const ancient = post({ id: "x", createdAt: new Date(now.getTime() - 30 * day).toISOString(), automation: { topic: "Ancient", theme: "data", sources: [] } });
  const recent = recentActivity([published, rejected, ancient], now);
  assert.deepEqual(recent.themes, ["frontend", "platform"]);
  assert.deepEqual(recent.rejectedTopics, ["Edge caching bill shock"]);
  assert.deepEqual(recent.topics, ["Server actions", "Edge caching bill shock"]);
  assert.ok(recent.sourceUrls.includes("https://vercel.com/b"));
  assert.equal(recent.previousTheme, "frontend");
  assert.deepEqual(recent.posts, [published.text], "a rejected opener does not constrain variety");
});
