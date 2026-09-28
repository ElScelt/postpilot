import test from "node:test";
import assert from "node:assert/strict";
import { listAutomationRuns, recordAutomationRun, type AutomationRun } from "../src/lib/storage/runs";

// postpilot:runs in memory, held as the JSON string Redis would hold. The function given
// to onNextWrite runs just before the next write lands, standing in for another request
// recording a run between this one's read and its write.
function fakeStore(initial: AutomationRun[] | null = null) {
  let raw = initial === null ? null : JSON.stringify(initial);
  let beforeWrite: (() => void) | undefined;
  return {
    store: {
      getRaw: async () => raw,
      compareAndSet: async (_key: string, expected: string, next: string) => {
        const pending = beforeWrite;
        beforeWrite = undefined;
        pending?.();
        if ((raw ?? "") !== expected) return false;
        raw = next;
        return true;
      },
    },
    read: () => (raw === null ? null : JSON.parse(raw) as AutomationRun[]),
    onNextWrite: (other: AutomationRun) => {
      beforeWrite = () => { raw = JSON.stringify([...(JSON.parse(raw ?? "[]") as AutomationRun[]), other]); };
    },
  };
}

const run: AutomationRun = { ranAt: "2026-07-23T05:00:00.000Z", status: "failed", reason: "Draft contains an unverified freshness claim." };

test("records a run so the reason outlives the seven-day QStash log window", async () => {
  const { store, read } = fakeStore();
  await recordAutomationRun(run, store);
  assert.deepEqual(read(), [run]);
});

test("appends to existing runs without dropping earlier ones", async () => {
  const earlier: AutomationRun = { ranAt: "2026-07-22T05:00:00.000Z", status: "skipped", reason: "No distinct evidence." };
  const { store, read } = fakeStore([earlier]);
  await recordAutomationRun(run, store);
  assert.deepEqual(read(), [earlier, run]);
});

test("retains only the most recent sixty runs", async () => {
  const existing = Array.from({ length: 60 }, (_, index): AutomationRun => ({
    ranAt: `2026-05-${String(index + 1).padStart(2, "0")}T05:00:00.000Z`, status: "scheduled",
  }));
  const { store, read } = fakeStore(existing);
  await recordAutomationRun(run, store);
  const stored = read() ?? [];
  assert.equal(stored.length, 60);
  assert.deepEqual(stored.at(-1), run);
  assert.equal(stored[0]?.ranAt, "2026-05-02T05:00:00.000Z");
});

test("never throws when the store is unavailable", async () => {
  const failing = {
    getRaw: async () => { throw new Error("Redis unreachable"); },
    compareAndSet: async () => true,
  };
  await assert.doesNotReject(() => recordAutomationRun(run, failing));
});

test("a run recorded while another request records one keeps both", async () => {
  const crash: AutomationRun = { ranAt: "2026-07-23T05:00:01.000Z", status: "failed", reason: "Tavily search failed (503)" };
  const { store, read, onNextWrite } = fakeStore();
  onNextWrite(crash);
  await recordAutomationRun(run, store);
  assert.deepEqual(read(), [crash, run]);
});

test("reports an empty history when nothing has been recorded", async () => {
  const { store } = fakeStore();
  assert.deepEqual(await listAutomationRuns(store), []);
});

test("a run entry this version cannot read is left out of the list but kept in the store", async () => {
  const legacy = { ranAt: "2026-07-20T05:00:00.000Z", status: "archived" };
  const { store, read } = fakeStore([legacy as unknown as AutomationRun, run]);
  assert.deepEqual(await listAutomationRuns(store), [run]);
  await recordAutomationRun(run, store);
  assert.deepEqual(read()?.[0], legacy, "recording a run must not rewrite the history it cannot read");
});
