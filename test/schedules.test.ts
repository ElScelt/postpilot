import test from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../src/lib/config";
import {
  describeLiveSchedule,
  nextScheduledRun,
  reconcileAutomationSchedules,
  runCron,
  scheduledPostTime,
  scheduleRequest,
} from "../src/lib/scheduling/schedules";
import { dayIndex } from "../src/lib/scheduling/time";

const tallinn: Pick<Config, "timeZone" | "schedule"> = {
  timeZone: "Europe/Tallinn", schedule: { days: ["sun", "tue", "thu"], runHour: 21 },
};
const tallinnMorning: Pick<Config, "timeZone" | "publishHour"> = { timeZone: "Europe/Tallinn", publishHour: 9 };

test("runs on the configured evenings in the configured time zone", () => {
  assert.equal(runCron(), "CRON_TZ=UTC 0 21 * * 0,2,4");
  assert.equal(runCron(tallinn), "CRON_TZ=Europe/Tallinn 0 21 * * 0,2,4");
  assert.equal(
    runCron({ timeZone: "Europe/Berlin", schedule: { days: ["fri", "mon", "mon"], runHour: 19 } }),
    "CRON_TZ=Europe/Berlin 0 19 * * 1,5",
  );
});

test("sends the schedule a real JSON payload without a copied bearer secret", () => {
  assert.deepEqual(scheduleRequest("https://example.com/api/automation/run", tallinn), {
    scheduleId: "postpilot-run",
    destination: "https://example.com/api/automation/run",
    cron: "CRON_TZ=Europe/Tallinn 0 21 * * 0,2,4",
    body: "{}",
    headers: { "Content-Type": "application/json" },
    retries: 3,
    label: "postpilot-run",
  });
});

function fakeClient(live: Record<string, { cron: string; destination: string }>) {
  const created: Array<{ scheduleId: string; cron: string; destination: string }> = [];
  const client = {
    schedules: {
      get: async (scheduleId: string) => {
        const schedule = live[scheduleId];
        if (!schedule) throw Object.assign(new Error("Not found"), { status: 404 });
        return { scheduleId, ...schedule };
      },
      create: async (request: { scheduleId: string; cron: string; destination: string }) => {
        created.push({ scheduleId: request.scheduleId, cron: request.cron, destination: request.destination });
        return { scheduleId: request.scheduleId };
      },
      delete: async () => { throw new Error("reconcile must never delete a live schedule"); },
    },
  } as never;
  return { client, created };
}

const destination = "https://example.com/api/automation/run";

test("reconcile rewrites a live schedule whose cron drifted from the code", async () => {
  const { client, created } = fakeClient({
    "postpilot-run": { cron: "CRON_TZ=Europe/Tallinn 0 21 * * 0-4", destination },
  });
  const changed = await reconcileAutomationSchedules({ client, destination, settings: tallinn });
  assert.deepEqual(created.map((request) => request.cron), ["CRON_TZ=Europe/Tallinn 0 21 * * 0,2,4"]);
  assert.match(changed[0]!, /0 21 \* \* 0-4 at https:\/\/example\.com.* -> CRON_TZ=Europe\/Tallinn 0 21 \* \* 0,2,4/);
});

test("reconcile leaves a matching schedule untouched", async () => {
  const { client, created } = fakeClient({
    "postpilot-run": { cron: "CRON_TZ=Europe/Tallinn 0 21 * * 0,2,4", destination },
  });
  assert.deepEqual(await reconcileAutomationSchedules({ client, destination, settings: tallinn }), []);
  assert.deepEqual(created, []);
});

test("reconcile ignores whitespace QStash may have normalised away", async () => {
  const { client, created } = fakeClient({
    "postpilot-run": { cron: "CRON_TZ=Europe/Tallinn  0 21 * * 0,2,4 ", destination },
  });
  assert.deepEqual(await reconcileAutomationSchedules({ client, destination, settings: tallinn }), []);
  assert.deepEqual(created, []);
});

test("reconcile creates the schedule when none exists", async () => {
  const { client, created } = fakeClient({});
  const changed = await reconcileAutomationSchedules({ client, destination, settings: tallinn });
  assert.equal(created.length, 1);
  assert.match(changed[0]!, /created CRON_TZ=Europe\/Tallinn 0 21 \* \* 0,2,4/);
});

test("reconcile rewrites a schedule pointing at a stale destination", async () => {
  const { client, created } = fakeClient({
    "postpilot-run": { cron: "CRON_TZ=Europe/Tallinn 0 21 * * 0,2,4", destination: "https://old.example.com/api/automation/run" },
  });
  await reconcileAutomationSchedules({ client, destination, settings: tallinn });
  assert.equal(created.length, 1);
});

test("a manual run never repoints a live schedule at its own host", async () => {
  const { client, created } = fakeClient({
    "postpilot-run": { cron: "CRON_TZ=Europe/Tallinn 0 21 * * 0,2,4", destination },
  });
  const changed = await reconcileAutomationSchedules({ client, destination: "http://localhost:3000/api/automation/run", manual: true, settings: tallinn });
  assert.deepEqual(created, []);
  assert.match(changed[0]!, /left alone by a manual run/);
});

test("a manual run still creates a missing schedule", async () => {
  const { client, created } = fakeClient({});
  await reconcileAutomationSchedules({ client, destination, manual: true, settings: tallinn });
  assert.equal(created.length, 1);
});

test("predicts the next firing from the configured schedule", () => {
  // Sunday 20:00 Tallinn fires the same evening; Sunday 22:00 waits for Tuesday.
  assert.equal(nextScheduledRun(new Date("2026-09-06T17:00:00.000Z"), tallinn).toISOString(), "2026-09-06T18:00:00.000Z");
  assert.equal(nextScheduledRun(new Date("2026-09-06T19:00:00.000Z"), tallinn).toISOString(), "2026-09-08T18:00:00.000Z");
  // Winter time: 21:00 Tallinn is 19:00Z.
  assert.equal(nextScheduledRun(new Date("2026-11-04T12:00:00.000Z"), tallinn).toISOString(), "2026-11-05T19:00:00.000Z");
  // The default configuration runs at 21:00 UTC.
  assert.equal(nextScheduledRun(new Date("2026-09-06T17:00:00.000Z")).toISOString(), "2026-09-06T21:00:00.000Z");
});

test("describes the live schedule for the dashboard without changing it", async () => {
  const cron = "CRON_TZ=UTC 0 21 * * 0,2,4";
  const { client, created } = fakeClient({ "postpilot-run": { cron, destination } });
  assert.deepEqual(await describeLiveSchedule(client), { id: "postpilot-run", cron, live: { cron, destination } });
  assert.deepEqual(await describeLiveSchedule(fakeClient({}).client), { id: "postpilot-run", cron, live: undefined });
  assert.deepEqual(created, []);
});

test("targets the next morning in Tallinn during daylight saving time", () => {
  assert.equal(scheduledPostTime(new Date("2026-07-14T18:00:00.000Z"), tallinnMorning).toISOString(), "2026-07-15T06:00:00.000Z");
});

test("targets the next morning in Tallinn during winter", () => {
  assert.equal(scheduledPostTime(new Date("2026-01-14T19:00:00.000Z"), tallinnMorning).toISOString(), "2026-01-15T07:00:00.000Z");
});

test("holds the 09:00 posting hour across a spring DST boundary", () => {
  assert.equal(scheduledPostTime(new Date("2026-03-28T19:00:00.000Z"), tallinnMorning).toISOString(), "2026-03-29T06:00:00.000Z");
});

test("holds the 09:00 posting hour across the autumn DST boundary", () => {
  assert.equal(scheduledPostTime(new Date("2026-10-24T18:00:00.000Z"), tallinnMorning).toISOString(), "2026-10-25T07:00:00.000Z");
  assert.equal(scheduledPostTime(new Date("2026-10-25T19:00:00.000Z"), tallinnMorning).toISOString(), "2026-10-26T07:00:00.000Z");
});

test("the publish hour follows the configuration", () => {
  const ten = { ...tallinnMorning, publishHour: 10 };
  assert.equal(scheduledPostTime(new Date("2026-07-14T18:00:00.000Z"), ten).toISOString(), "2026-07-15T07:00:00.000Z");
  // The default configuration publishes at 09:00 UTC.
  assert.equal(scheduledPostTime(new Date("2026-07-14T18:00:00.000Z")).toISOString(), "2026-07-15T09:00:00.000Z");
});

test("a retry after midnight still targets the same morning", () => {
  // Monday 01:30 Tallinn still has seven hours to go; Monday 08:30 does not.
  assert.equal(scheduledPostTime(new Date("2026-09-06T22:30:00.000Z"), tallinnMorning).toISOString(), "2026-09-07T06:00:00.000Z");
  assert.equal(scheduledPostTime(new Date("2026-09-07T05:30:00.000Z"), tallinnMorning).toISOString(), "2026-09-08T06:00:00.000Z");
});

test("the day index moves at UTC midnight and nowhere else", () => {
  const day = dayIndex(new Date("2026-09-28T00:00:00Z"));
  assert.equal(dayIndex(new Date("2026-09-28T23:59:59.999Z")), day);
  assert.equal(dayIndex(new Date("2026-09-29T00:00:00Z")), day + 1);
  assert.equal(dayIndex(new Date(0)), 0);
});

test("reconcile gives up on a QStash that does not answer, so the run records a warning in time", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let called!: () => void;
  const reached = new Promise<void>((resolve) => { called = resolve; });
  const client = { schedules: { get: () => { called(); return new Promise<never>(() => {}); } } } as never;
  const reconciling = reconcileAutomationSchedules({ client, destination, settings: tallinn });
  await reached;
  t.mock.timers.tick(10_000);
  await assert.rejects(() => reconciling, /QStash did not answer within 10 seconds/);
});
