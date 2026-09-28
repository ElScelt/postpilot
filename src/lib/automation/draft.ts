import { DraftRejectedError } from "../drafting/pipeline";
import type { QueuedPost } from "../storage/posts";
import { ntfyWorstCaseMs } from "../notify/ntfy";
import { redisTimeoutMs } from "../storage/redis";
import { qstashTimeoutMs } from "../scheduling/qstash";
import { runTimeLimitSeconds } from "../limits";
import { announce } from "./announce";
import { recentActivity } from "./recent-activity";
import type { Run } from "./run";

// Drafting gets the route's time limit less the worst case of what the run still does
// afterwards, each step answering or timing out once: store the post, queue its publish
// message, record the message id, send the notice with every retry, record that it was
// sent, record the run and release the lock. Past the drafting deadline the platform
// would kill the run before it recorded anything. A run killed later leaves the post
// stored, and QStash's retry finishes it (finishQueuedPost).
const redisStepsAfterDrafting = 5;
export const finishReserveMs = redisStepsAfterDrafting * redisTimeoutMs + qstashTimeoutMs + ntfyWorstCaseMs;
export const draftingBudgetMs = runTimeLimitSeconds * 1000 - finishReserveMs;

export async function draftAndQueue(run: Run, posts: QueuedPost[]) {
  const { now, scheduledFor, options, deps, warnings } = run;
  let outcome;
  try {
    // The budget runs from the start of the run, not from here: the sweep, the schedule
    // and the token checks have already spent some of the route's time.
    outcome = await deps.generateGroundedDraft(recentActivity(posts, now), { now, deadline: now.getTime() + draftingBudgetMs });
  } catch (error) {
    if (!(error instanceof DraftRejectedError)) throw error;
    // Recorded here so the rejected drafts survive; the route still answers 500 so
    // QStash retries with a fresh sample, which rescues most such nights.
    await run.record({ status: "failed", reason: error.message, theme: error.theme, attempts: error.attempts });
    if (options.finalAttempt ?? true) {
      await deps.notifyOperator({
        title: "No LinkedIn post tonight: the draft failed validation",
        body: `Theme ${error.theme}. Last rejection: ${error.message}`,
        priority: 3,
      });
    }
    throw error;
  }
  const { decision, theme, themesTried, evidenceHosts, attempts } = outcome;
  if (outcome.notes?.length) warnings.push(...outcome.notes);
  if (!decision.shouldPost) {
    await run.record({ status: "skipped", reason: decision.reason, theme, themesTried, evidenceHosts, attempts });
    await deps.notifyOperator({
      title: "No LinkedIn post tonight", body: decision.reason, priority: 2, tags: "zzz",
    });
    return { status: "skipped" as const, reason: decision.reason };
  }

  const post = await deps.schedulePost(decision.text, scheduledFor.toISOString(), {
    topic: decision.topic,
    theme: decision.theme,
    sources: decision.sources,
  });
  await announce(run, post);
  await run.record({
    status: "scheduled", postId: post.id, topic: decision.topic,
    theme, themesTried, evidenceHosts, attempts, scheduledFor: post.scheduledFor,
  });
  return {
    status: "scheduled" as const,
    id: post.id,
    scheduledFor: post.scheduledFor,
    topic: decision.topic,
    theme: decision.theme,
    sources: decision.sources,
    warnings,
  };
}
