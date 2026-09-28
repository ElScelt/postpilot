import { isLive, type QueuedPost } from "../storage/posts";
import { appUrl } from "../env";
import { formatDateTime } from "../scheduling/time";
import { errorMessage } from "../errors";
import type { Run } from "./run";

// A post the automation already made for this morning, still on its way or already out.
export function findDuplicate(posts: QueuedPost[], scheduledFor: Date) {
  return posts.find((post) =>
    post.automation !== undefined
    && post.scheduledFor.slice(0, 10) === scheduledFor.toISOString().slice(0, 10)
    && (isLive(post) || post.status === "posted"),
  );
}

// A queued post an earlier attempt stored but was killed or failed before it scheduled
// its delivery or announced it. Drafting again would throw the story away and cost the
// owner nothing but a fresh sample; finishing it keeps the one already researched.
export function unfinished(post: QueuedPost, ntfyTopic: string | undefined) {
  return post.status === "queued" && (!post.qstashMessageId || (ntfyTopic !== undefined && !post.notifiedAt));
}

export async function finishQueuedPost(run: Run, stored: QueuedPost) {
  const { deps, warnings } = run;
  warnings.push(`Finished post ${stored.id}, which an earlier attempt stored but did not ${stored.qstashMessageId ? "announce" : "schedule"}.`);
  const post = stored.qstashMessageId ? stored : await deps.scheduleDelivery(stored);
  await announce(run, post);
  await run.record({
    status: "scheduled", postId: post.id, topic: post.automation?.topic, theme: post.automation?.theme, scheduledFor: post.scheduledFor,
  });
  return {
    status: "scheduled" as const,
    id: post.id,
    scheduledFor: post.scheduledFor,
    topic: post.automation?.topic,
    theme: post.automation?.theme,
    sources: post.automation?.sources ?? [],
    warnings,
  };
}

// The notice is the owner's only chance to review the draft, so a post never publishes
// without it. A failed notice fails the run; QStash's retry finds the post stored but
// not announced and sends the notice again. With no retry left, the post is withdrawn
// instead: a night without a post is better than a post nobody reviewed.
export async function announce({ options, deps, warnings }: Run, post: QueuedPost) {
  const topic = deps.ntfyTopic;
  if (!topic) {
    warnings.push("NTFY_TOPIC is unset, so the draft publishes without review.");
    return;
  }
  if (await deps.notifyDraftQueued({ postId: post.id, text: post.text, scheduledFor: post.scheduledFor, topic, appUrl: appUrl() })) {
    try {
      await deps.transitionPost(post.id, ["queued"], { notifiedAt: new Date().toISOString() });
    } catch (error) {
      // The owner has the notice; at worst a retry sends it a second time.
      warnings.push(`The notice went out but could not be recorded: ${errorMessage(error)}`);
    }
    return;
  }
  if (!(options.finalAttempt ?? true)) {
    throw new Error(`The review notice for the post scheduled for ${formatDateTime(post.scheduledFor)} could not be delivered; QStash retries the run, which sends it again.`);
  }
  await deps.transitionPost(post.id, ["queued"], {
    status: "failed", error: "Withdrawn because the review notice could not be delivered; a post nobody could review is never published.",
  });
  throw new Error(`The review notice could not be delivered on any attempt, so the post scheduled for ${formatDateTime(post.scheduledFor)} was withdrawn and will not publish.`);
}
