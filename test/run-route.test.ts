import test from "node:test";
import assert from "node:assert/strict";
import { handleRunRequest, type RunRequestDeps } from "../src/app/api/automation/run/handler";
import { DraftRejectedError } from "../src/lib/drafting/pipeline";
import { runAutomation, type RunOptions } from "../src/lib/automation";
import type { AutomationRun } from "../src/lib/storage/runs";
import type { QueuedPost } from "../src/lib/storage/posts";
import { scheduledPostTime } from "../src/lib/scheduling/schedules";

process.env.AUTOMATION_SECRET = "run-secret";
process.env.APP_URL = "https://example.vercel.app";

type Outcome = Awaited<ReturnType<RunRequestDeps["runAutomation"]>>;

function fakes(run: () => Promise<Outcome> = async () => ({ status: "skipped", reason: "nothing tonight" })) {
  const calls = { options: [] as RunOptions[], heartbeats: [] as boolean[], runs: [] as AutomationRun[], alerts: [] as string[] };
  const deps: RunRequestDeps = {
    runAutomation: async (_now, _overrides, options = {}) => { calls.options.push(options); return run(); },
    pingHeartbeat: async (ok) => { calls.heartbeats.push(ok); return true; },
    recordAutomationRun: async (record) => { calls.runs.push(record); return record; },
    notifyOperator: async (alert) => { calls.alerts.push(alert.title); return true; },
    verifySignature: async (request) => request.headers.get("upstash-signature") === "valid",
  };
  return { deps, calls };
}

function signed(retried?: number, body = "{}") {
  const headers: Record<string, string> = { "upstash-signature": "valid" };
  if (retried !== undefined) headers["upstash-retried"] = String(retried);
  return new Request("https://example.vercel.app/api/automation/run", { method: "POST", headers, body });
}

function manual(secret = "run-secret", body = "") {
  return new Request("https://example.vercel.app/api/automation/run", {
    method: "POST", headers: { authorization: `Bearer ${secret}` }, body,
  });
}

test("refuses a request with neither a valid signature nor the secret", async () => {
  const { deps, calls } = fakes();
  const forged = new Request("https://example.vercel.app/api/automation/run", {
    method: "POST", headers: { "upstash-signature": "forged" }, body: "{}",
  });
  assert.equal((await handleRunRequest(forged, deps)).status, 401);
  assert.equal((await handleRunRequest(manual("wrong"), deps)).status, 401);
  assert.equal(calls.options.length, 0);
});

test("refuses a body that is not an empty JSON object", async () => {
  const { deps, calls } = fakes();
  assert.equal((await handleRunRequest(manual("run-secret", "not json"), deps)).status, 400);
  assert.equal((await handleRunRequest(manual("run-secret", '{"slot":"evening"}'), deps)).status, 400);
  assert.equal((await handleRunRequest(manual("run-secret", '{"slot":"morning"}'), deps)).status, 200, "old schedules still send the slot");
  assert.equal(calls.options.length, 1);
});

test("only the last QStash delivery counts as the final attempt", async () => {
  const { deps, calls } = fakes();
  for (const retried of [undefined, 0, 1, 2, 3]) await handleRunRequest(signed(retried), deps);
  assert.deepEqual(calls.options.map((options) => options.finalAttempt), [false, false, false, false, true]);
  assert.ok(calls.options.every((options) => options.manual === false));
});

test("a run started by hand is final and never repoints the schedule", async () => {
  const { deps, calls } = fakes();
  await handleRunRequest(manual(), deps);
  assert.deepEqual(calls.options, [{ manual: true, finalAttempt: true }]);
});

test("a finished run answers with its result and pings the heartbeat", async () => {
  const { deps, calls } = fakes();
  const response = await handleRunRequest(signed(), deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "skipped", reason: "nothing tonight" });
  assert.deepEqual(calls.heartbeats, [true]);
});

test("a crash is recorded, fails the heartbeat and answers 500 so QStash retries", async () => {
  const { deps, calls } = fakes(async () => { throw new Error("Tavily search failed (503)"); });
  const response = await handleRunRequest(signed(0), deps);
  assert.equal(response.status, 500);
  assert.deepEqual(calls.heartbeats, [false]);
  assert.equal(calls.runs[0]!.status, "failed");
  assert.equal(calls.runs[0]!.reason, "Tavily search failed (503)");
  assert.deepEqual(calls.alerts, [], "QStash still has retries");
});

test("the crash of the last attempt alerts the owner", async () => {
  const { deps, calls } = fakes(async () => { throw new Error("Tavily search failed (503)"); });
  await handleRunRequest(signed(3), deps);
  assert.deepEqual(calls.alerts, ["LinkedIn automation run failed"]);
});

test("a rejected draft is not recorded a second time", async () => {
  const { deps, calls } = fakes(async () => { throw new DraftRejectedError("em-dash", [], "frontend"); });
  const response = await handleRunRequest(signed(3), deps);
  assert.equal(response.status, 500);
  assert.equal(calls.runs.length, 0, "runAutomation already recorded it with its attempts");
  assert.deepEqual(calls.alerts, [], "runAutomation already alerted");
});

// The real orchestrator with only its lock and storage faked, so the test covers what
// runAutomation reports for a held lock as well as how the route answers it.
function realRun(state: { locked: boolean; posts: QueuedPost[] }, runs: AutomationRun[]): RunRequestDeps["runAutomation"] {
  return (now, _overrides, options) => runAutomation(now, {
    acquireRunLock: async () => (state.locked ? undefined : "token"),
    releaseRunLock: async () => {},
    listPosts: async () => state.posts,
    recordAutomationRun: async (record) => { runs.push(record); return record; },
    reconcileAutomationSchedules: async () => [],
    linkedInTokenStatus: async () => ({ state: "valid", daysRemaining: 40 }),
  }, options);
}

test("a QStash retry that finds a run in progress asks to be retried instead of reporting a healthy skip", async () => {
  const { deps, calls } = fakes();
  deps.runAutomation = realRun({ locked: true, posts: [] }, calls.runs);
  const response = await handleRunRequest(signed(1), deps);
  assert.equal(response.status, 503, "QStash only retries a non-2xx answer");
  assert.deepEqual(calls.heartbeats, [], "the run holding the lock pings when it finishes");
  assert.deepEqual(calls.runs, [], "a retry that never ran is not a run");
  assert.deepEqual(calls.alerts, []);
});

test("the last QStash retry that still finds the lock held alerts and fails the heartbeat", async () => {
  const { deps, calls } = fakes();
  deps.runAutomation = realRun({ locked: true, posts: [] }, calls.runs);
  const response = await handleRunRequest(signed(3), deps);
  assert.equal(response.status, 503);
  assert.deepEqual(calls.heartbeats, [false]);
  assert.deepEqual(calls.alerts, ["The run could not start"]);
});

test("a run started by hand while another is in progress is told so", async () => {
  const { deps, calls } = fakes();
  deps.runAutomation = realRun({ locked: true, posts: [] }, calls.runs);
  const response = await handleRunRequest(manual(), deps);
  assert.equal(response.status, 409);
  assert.deepEqual(calls.heartbeats, []);
});

test("the retry after the first run queued its post ends cleanly", async () => {
  const { deps, calls } = fakes();
  const state = { locked: true, posts: [] as QueuedPost[] };
  deps.runAutomation = realRun(state, calls.runs);
  assert.equal((await handleRunRequest(signed(1), deps)).status, 503);
  // The first run finishes: it queues tomorrow's post and releases the lock.
  state.locked = false;
  state.posts = [{
    id: "queued", text: "t", scheduledFor: scheduledPostTime(new Date()).toISOString(), status: "queued",
    createdAt: new Date().toISOString(), automation: { topic: "t", theme: "frontend", sources: [] },
  }];
  const response = await handleRunRequest(signed(2), deps);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "skipped");
  assert.deepEqual(calls.heartbeats, [true]);
  assert.match(calls.runs[0]!.reason!, /already created post queued/);
});
