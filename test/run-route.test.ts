import test from "node:test";
import assert from "node:assert/strict";
import { handleRunRequest, type RunRequestDeps } from "../src/app/api/automation/run/handler";
import { DraftRejectedError } from "../src/lib/drafting/pipeline";
import type { RunOptions } from "../src/lib/automation";
import type { AutomationRun } from "../src/lib/storage/runs";

process.env.AUTOMATION_SECRET = "run-secret";

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
