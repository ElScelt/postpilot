import { addPost, postStatuses, transitionPost, type AutomationMetadata, type PostStoreDeps, type QueuedPost } from "./storage/posts";
import { deliveryTimestamp, publishingUrl, qstash, qstashTimeoutMs } from "./scheduling/qstash";
import { withTimeout } from "./async";
import { publishRetries } from "./limits";
import { errorMessage } from "./errors";

// The store and the delivery service a queued post needs, injectable so tests run
// without Upstash.
export type QueueDeps = PostStoreDeps & {
  publisher?: Pick<ReturnType<typeof qstash>, "publishJSON">;
};

// Stores the post, then asks QStash to deliver it at its publish time. A post QStash
// refused is marked failed, so it can never sit in the queue looking like pending work.
export async function schedulePost(text: string, scheduledFor: string, automation?: AutomationMetadata, deps: QueueDeps = {}) {
  const post = await addPost(text, scheduledFor, automation, deps);
  try {
    const messageId = await enqueueDelivery(post, deps);
    post.qstashMessageId = messageId;
    // The owner may have rejected it already; the message id is worth keeping either way.
    await transitionPost(post.id, postStatuses, { qstashMessageId: messageId }, deps);
    return post;
  } catch (error) {
    post.status = "failed";
    post.error = errorMessage(error);
    await transitionPost(post.id, ["queued"], { status: "failed", error: post.error }, deps);
    throw error;
  }
}

// The delayed message that publishes the post. Its deduplication id is the post id, so
// sending it again, as the SDK does when a response is lost, never adds a second
// delivery at 09:00.
export async function enqueueDelivery(post: Pick<QueuedPost, "id" | "scheduledFor">, deps: QueueDeps = {}) {
  const publisher = deps.publisher ?? qstash();
  const result = await withTimeout(publisher.publishJSON({
    url: publishingUrl(),
    body: { postId: post.id },
    notBefore: deliveryTimestamp(post.scheduledFor),
    retries: publishRetries,
    label: ["postpilot-publish", post.id],
    redact: { body: true },
    deduplicationId: post.id,
  }), qstashTimeoutMs, "QStash");
  return result.messageId;
}
