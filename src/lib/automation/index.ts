import { generateGroundedDraft } from "../drafting/pipeline";
import { listPosts, transitionPost } from "../storage/posts";
import { scheduleDelivery, schedulePost } from "../queue-post";
import { recordAutomationRun } from "../storage/runs";
import { reconcileAutomationSchedules, scheduledPostTime } from "../scheduling/schedules";
import { linkedInTokenStatus } from "../linkedin/token";
import { notifyDraftQueued, notifyOperator } from "../notify/ntfy";
import { envValue } from "../env";
import { acquireRunLock, releaseRunLock, runLockKey } from "../storage/run-lock";
import { runTimeLimitSeconds } from "../limits";
import { errorMessage } from "../errors";
import { retireStuckPosts } from "./sweep";
import { checkAuthorization } from "./authorization";
import { findDuplicate, finishQueuedPost, unfinished } from "./announce";
import { draftAndQueue } from "./draft";
import type { AutomationDeps, Run, RunOptions } from "./run";

export type { AutomationDeps, RunOptions } from "./run";
export { draftingBudgetMs, finishReserveMs } from "./draft";
export { recentActivity } from "./recent-activity";

// The nightly run, one step per module: the sweep, the schedule, the authorization,
// finishing a post an earlier attempt left half done, and drafting a new one.

function productionDeps(): AutomationDeps {
  return {
    listPosts, transitionPost, schedulePost, scheduleDelivery, linkedInTokenStatus, generateGroundedDraft,
    reconcileAutomationSchedules, notifyDraftQueued, notifyOperator, recordAutomationRun,
    acquireRunLock: (key, ttlSeconds) => acquireRunLock(key, ttlSeconds),
    releaseRunLock: (key, token) => releaseRunLock(key, token),
    ntfyTopic: envValue("NTFY_TOPIC"),
  };
}

export async function runAutomation(
  now = new Date(),
  overrides: Partial<AutomationDeps> = {},
  options: RunOptions = {},
) {
  const deps = { ...productionDeps(), ...overrides };
  const scheduledFor = scheduledPostTime(now);

  // Two runs for the same morning (a manual test landing during the scheduled firing)
  // would each pass the duplicate check below against a stale snapshot and queue two
  // posts. The lock is released at the end so a retry after a failure can still run, and
  // it expires when the platform would kill the run, so a killed run cannot hold it
  // through QStash's retries.
  const lockKey = runLockKey(scheduledFor);
  const lockToken = await deps.acquireRunLock(lockKey, runTimeLimitSeconds);
  if (!lockToken) {
    // Not a run and not a skip: the route asks QStash to come back, and the retry finds
    // either the lock free or the post already queued.
    return { status: "busy" as const, reason: "Another automation run for this morning is already in progress." };
  }

  const warnings: string[] = [];
  const run: Run = {
    now, scheduledFor, options, deps, warnings,
    record: (fields) => deps.recordAutomationRun({
      ranAt: now.toISOString(), ...fields,
      warning: warnings.length ? warnings.join(" ") : undefined, durationMs: Date.now() - now.getTime(),
    }),
  };

  try {
    const posts = await deps.listPosts();
    await retireStuckPosts(run, posts);
    await reconcileSchedule(run);
    const stopped = await checkAuthorization(run);
    if (stopped) return stopped;

    const duplicate = findDuplicate(posts, scheduledFor);
    if (duplicate && unfinished(duplicate, deps.ntfyTopic)) return await finishQueuedPost(run, duplicate);
    if (duplicate) {
      const reason = `Automation already created post ${duplicate.id}.`;
      await run.record({ status: "skipped", reason });
      return { status: "skipped" as const, reason };
    }
    return await draftAndQueue(run, posts);
  } finally {
    await deps.releaseRunLock(lockKey, lockToken);
  }
}

// The live QStash schedule follows the code, not the other way round. A failure here
// must never cost tonight's post; it only surfaces as a warning on the run record.
async function reconcileSchedule({ deps, options, warnings }: Run) {
  try {
    for (const change of await deps.reconcileAutomationSchedules({ manual: options.manual })) {
      warnings.push(`Schedule reconciled (${change}).`);
    }
  } catch (error) {
    warnings.push(`Schedule reconciliation failed: ${errorMessage(error)}`);
  }
}
