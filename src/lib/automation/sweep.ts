import { abandonedPosts, PostStateError, type QueuedPost } from "../storage/posts";
import { formatDateTime } from "../scheduling/time";
import type { Run } from "./run";

// Sweep first: a post still queued hours after its slot never reached LinkedIn.
// Retiring it must happen even when the run cannot proceed, because a dead
// authorization is precisely what leaves posts stranded in the queue. A post a killed
// delivery left publishing may be on LinkedIn, so it is retired without a retry.
export async function retireStuckPosts({ now, deps, warnings }: Run, posts: QueuedPost[]) {
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
}
