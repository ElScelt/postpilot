import { DraftRejectedError, draftingBudgetMs, generateGroundedDraft } from "./drafting/pipeline";
import { scheduledPostTime } from "./scheduling/schedules";
import { abandonedPosts, isLive, listPosts, PostStateError, schedulePost, transitionPost, type QueuedPost } from "./storage/posts";
import { recordAutomationRun } from "./storage/runs";
import { reconcileAutomationSchedules } from "./scheduling/schedules";
import { linkedInTokenStatus } from "./linkedin/api";
import { notifyDraftQueued, notifyOperator } from "./notify/ntfy";
import { appUrl } from "./env";
import { connectUrl } from "./linkedin/oauth";
import { acquireRunLock, releaseRunLock } from "./storage/run-lock";
import { runTimeLimitSeconds } from "./scheduling/qstash";
import { formatDateTime } from "./scheduling/time";
import type { RecentActivity } from "./drafting/prompt";
import { errorMessage } from "./errors";

// Everything the run touches outside its own logic, so a test can drive the whole
// orchestration with fakes. Production fills in the real modules.
export type AutomationDeps = {
  listPosts: typeof listPosts;
  transitionPost: typeof transitionPost;
  schedulePost: typeof schedulePost;
  linkedInTokenStatus: typeof linkedInTokenStatus;
  generateGroundedDraft: typeof generateGroundedDraft;
  reconcileAutomationSchedules: typeof reconcileAutomationSchedules;
  notifyDraftQueued: typeof notifyDraftQueued;
  notifyOperator: typeof notifyOperator;
  recordAutomationRun: typeof recordAutomationRun;
  // A token for this run, or undefined while another run holds the lock.
  acquireRunLock: (key: string, ttlSeconds: number) => Promise<string | undefined>;
  releaseRunLock: (key: string, token: string) => Promise<void>;
};

function productionDeps(): AutomationDeps {
  return {
    listPosts, transitionPost, schedulePost, linkedInTokenStatus, generateGroundedDraft,
    reconcileAutomationSchedules, notifyDraftQueued, notifyOperator, recordAutomationRun,
    acquireRunLock: (key, ttlSeconds) => acquireRunLock(key, ttlSeconds),
    releaseRunLock: (key, token) => releaseRunLock(key, token),
  };
}

export type RunOptions = {
  // A bearer-authenticated call from a person rather than a QStash firing. Manual runs
  // never repoint the live schedule at whatever host they were sent to.
  manual?: boolean;
  // QStash retries a failed run three times; alerts about a failed draft go out only
  // once the last attempt has failed, so a night that recovers on retry stays quiet.
  finalAttempt?: boolean;
};

const reconnect = "Reconnect at /api/auth/linkedin.";
const recentWindowMs = 14 * 24 * 60 * 60 * 1000;

export async function runAutomation(
  now = new Date(),
  overrides: Partial<AutomationDeps> = {},
  options: RunOptions = {},
) {
  const deps = { ...productionDeps(), ...overrides };
  const ranAt = now.toISOString();
  const scheduledFor = scheduledPostTime(now);
  const reconnectLink = connectUrl();
  const finalAttempt = options.finalAttempt ?? true;

  // Two runs for the same morning (a manual test landing during the scheduled firing)
  // would each pass the duplicate check below against a stale snapshot and queue two
  // posts. The lock is released at the end so a retry after a failure can still run, and
  // it expires when the platform would kill the run, so a killed run cannot hold it
  // through QStash's retries.
  const lockKey = `postpilot:run-lock:${scheduledFor.toISOString().slice(0, 10)}`;
  const lockToken = await deps.acquireRunLock(lockKey, runTimeLimitSeconds);
  if (!lockToken) {
    // Not a run and not a skip: the route asks QStash to come back, and the retry finds
    // either the lock free or the post already queued.
    return { status: "busy" as const, reason: "Another automation run for this morning is already in progress." };
  }

  const warnings: string[] = [];
  const warning = () => (warnings.length ? warnings.join(" ") : undefined);
  const durationMs = () => Date.now() - now.getTime();

  try {
    const posts = await deps.listPosts();

    // Sweep first: a post still queued hours after its slot never reached LinkedIn.
    // Retiring it must happen even when the run cannot proceed, because a dead
    // authorization is precisely what leaves posts stranded in the queue. A post a killed
    // delivery left publishing may be on LinkedIn, so it is retired without a retry.
    for (const abandoned of abandonedPosts(posts, now)) {
      const midPublish = abandoned.status === "publishing";
      const error = midPublish
        ? "A delivery stopped while publishing the post; it may be live. It will not be retried."
        : abandoned.error ?? "Post was never published before its scheduled time elapsed.";
      try {
        await deps.transitionPost(abandoned.id, [abandoned.status], { status: "failed", error });
      } catch (refusal) {
        // Published or rejected since the list was read: nothing is stranded after all.
        if (refusal instanceof PostStateError) continue;
        throw refusal;
      }
      warnings.push(`Earlier post ${abandoned.id} ${midPublish ? "may not have published" : "never published"}: ${error}`);
      await deps.notifyOperator(midPublish
        ? {
          title: "A LinkedIn post may or may not have gone out",
          body: `The post scheduled for ${formatDateTime(abandoned.scheduledFor)} was retired: ${error} Look for it on LinkedIn and post it by hand only if it is not there.`,
          priority: 5,
        }
        : {
          title: "A LinkedIn post never went out",
          body: `The post scheduled for ${formatDateTime(abandoned.scheduledFor)} was retired: ${error} Check LinkedIn before posting it by hand.`,
          priority: 4,
        });
    }

    // The live QStash schedule follows the code, not the other way round. A failure here
    // must never cost tonight's post; it only surfaces as a warning on the run record.
    try {
      for (const change of await deps.reconcileAutomationSchedules(undefined, undefined, { manual: options.manual })) {
        warnings.push(`Schedule reconciled (${change}).`);
      }
    } catch (error) {
      warnings.push(`Schedule reconciliation failed: ${errorMessage(error)}`);
    }

    // Drafting against a dead authorization queues a post nothing can publish, so stop
    // here and make the run record say so. Retrying cannot fix it, hence the 200.
    const token = await deps.linkedInTokenStatus(now.getTime());
    if (token.state !== "valid") {
      const reason = token.state === "missing"
        ? `LinkedIn is not connected. ${reconnect}`
        : `LinkedIn authorization expired ${Math.abs(token.daysRemaining)} days ago. ${reconnect}`;
      await deps.notifyOperator({
        title: "LinkedIn posting is stopped", body: `${reason} No post was drafted tonight.`, priority: 5, tags: "rotating_light", link: reconnectLink,
      });
      await deps.recordAutomationRun({ ranAt, status: "failed", reason, warning: warning(), durationMs: durationMs() });
      return { status: "skipped" as const, reason };
    }

    // The post goes out twelve hours after this check, so judge the token against the
    // publish instant. The draft still queues: an overnight reconnect saves it, whereas
    // refusing the run would forfeit the night outright.
    const atPublish = await deps.linkedInTokenStatus(scheduledFor.getTime() + 60 * 60 * 1000);
    if (atPublish.state !== "valid") {
      warnings.push(`LinkedIn authorization expires before the ${formatDateTime(scheduledFor)} publish. ${reconnect}`);
      await deps.notifyOperator({
        title: "Reconnect LinkedIn tonight",
        body: `The authorization expires before tomorrow's ${formatDateTime(scheduledFor)} publish. Reconnect now or the post will not go out.`,
        priority: 5, tags: "rotating_light", link: reconnectLink,
      });
    } else if (token.daysRemaining <= 10) {
      warnings.push(`LinkedIn authorization expires in ${token.daysRemaining} days. ${reconnect}`);
      await deps.notifyOperator({
        title: `LinkedIn authorization expires in ${token.daysRemaining} days`,
        body: "LinkedIn issues no refresh token, so open the link and approve the consent screen again before it lapses.",
        priority: 3, tags: "hourglass", link: reconnectLink,
      });
    }

    const duplicate = posts.find((post) =>
      post.automation !== undefined
      && post.scheduledFor.slice(0, 10) === scheduledFor.toISOString().slice(0, 10)
      && (isLive(post) || post.status === "posted"),
    );
    if (duplicate) {
      const reason = `Automation already created post ${duplicate.id}.`;
      await deps.recordAutomationRun({ ranAt, status: "skipped", reason, warning: warning(), durationMs: durationMs() });
      return { status: "skipped" as const, reason };
    }

    const recent = recentActivity(posts, now);
    let outcome;
    try {
      // The budget runs from the start of the run, not from here: the sweep, the schedule
      // and the token checks have already spent some of the route's time.
      outcome = await deps.generateGroundedDraft(recent, now, undefined, { deadline: now.getTime() + draftingBudgetMs });
    } catch (error) {
      if (!(error instanceof DraftRejectedError)) throw error;
      // Recorded here so the rejected drafts survive; the route still answers 500 so
      // QStash retries with a fresh sample, which rescues most such nights.
      await deps.recordAutomationRun({
        ranAt, status: "failed", reason: error.message, warning: warning(),
        theme: error.theme, attempts: error.attempts, durationMs: durationMs(),
      });
      if (finalAttempt) {
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
      await deps.recordAutomationRun({
        ranAt, status: "skipped", reason: decision.reason, warning: warning(),
        theme, themesTried, evidenceHosts, attempts, durationMs: durationMs(),
      });
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
    const topic = process.env.NTFY_TOPIC;
    if (!topic) {
      warnings.push("NTFY_TOPIC is unset, so the draft publishes without review.");
    } else if (!(await deps.notifyDraftQueued({
      postId: post.id, text: decision.text, scheduledFor: post.scheduledFor, topic, appUrl: appUrl(),
    }))) {
      warnings.push("Draft notification could not be delivered.");
    }
    await deps.recordAutomationRun({
      ranAt, status: "scheduled", postId: post.id, topic: decision.topic,
      warning: warning(), theme, themesTried, evidenceHosts, attempts, scheduledFor: post.scheduledFor, durationMs: durationMs(),
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
  } finally {
    await deps.releaseRunLock(lockKey, lockToken);
  }
}

// What tonight's draft must differ from. Published and queued posts constrain the
// opener and closer and set the previous theme; every recent draft, including one the
// owner rejected overnight, counts toward the theme rotation and the topics and sources
// to avoid, so the Reject tap never makes the same story come straight back.
export function recentActivity(posts: QueuedPost[], now: Date): RecentActivity {
  const cutoff = now.getTime() - recentWindowMs;
  const window = posts.filter((post) => new Date(post.createdAt).getTime() >= cutoff);
  const live = window.filter((post) => post.status !== "cancelled");
  const rejected = window.filter((post) => post.status === "cancelled");
  return {
    posts: live.map((post) => post.text),
    topics: window.map((post) => post.automation?.topic ?? "").filter(Boolean),
    sourceUrls: window.flatMap((post) => post.automation?.sources.map((source) => source.url) ?? []),
    themes: window.map((post) => post.automation?.theme ?? "").filter(Boolean),
    previousTheme: live.map((post) => post.automation?.theme).filter(Boolean).at(-1),
    rejectedTopics: rejected.map((post) => post.automation?.topic ?? "").filter(Boolean),
  };
}
