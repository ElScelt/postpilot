import { NextResponse } from "next/server";
import { z } from "zod";
import { listPosts, PostNotQueuedError, staleClaimMs, transitionPost } from "@/lib/storage/posts";
import { LinkedInPublishError, publishTextPost } from "@/lib/linkedin/publish";
import { connectUrl } from "@/lib/linkedin/oauth";
import { notifyOperator } from "@/lib/notify/ntfy";
import { authorizeQStashRequest, verifyQStashSignature } from "@/lib/security/request-auth";
import { deliveryAttempt } from "@/lib/scheduling/qstash";
import { publishRetries } from "@/lib/limits";
import { formatDateTime } from "@/lib/scheduling/time";
import { errorMessage } from "@/lib/errors";

// Everything the publish route calls, injectable so tests drive the handler with fakes.
// route.ts may only export route fields, which is why this lives beside it.
export type PublishDeps = {
  listPosts: typeof listPosts;
  transitionPost: typeof transitionPost;
  publishTextPost: typeof publishTextPost;
  notifyOperator: typeof notifyOperator;
  verifySignature: typeof verifyQStashSignature;
  clock: () => Date;
};

const productionDeps: PublishDeps = {
  listPosts, transitionPost, publishTextPost, notifyOperator, verifySignature: verifyQStashSignature, clock: () => new Date(),
};

const requestSchema = z.object({ postId: z.string().min(1) });

function parsePostId(body: string) {
  try {
    return requestSchema.parse(JSON.parse(body)).postId;
  } catch {
    return undefined;
  }
}

// A post goes to LinkedIn at most once. The delivery first claims it (queued to
// publishing), so a Reject, an edit or a second delivery cannot slip in while LinkedIn
// is answering. What happens next depends on whether LinkedIn can have the post:
//   - it has it: the post is marked posted, and the answer is 2xx whatever happens to
//     that write, because a 5xx would make QStash publish it again;
//   - it cannot have it: the post goes back to the queue and QStash retries;
//   - nobody knows (a timeout, a broken connection, a server error): the post is marked
//     failed, the owner is told to check LinkedIn, and it is never retried.
export async function handlePublish(request: Request, overrides: Partial<PublishDeps> = {}) {
  const deps = { ...productionDeps, ...overrides };
  const body = await request.text();
  if (!(await authorizeQStashRequest(request, body, deps.verifySignature))) return new NextResponse("Unauthorized", { status: 401 });
  const postId = parsePostId(body);
  if (!postId) return new NextResponse("Missing post id", { status: 400 });
  const { attempt, final } = deliveryAttempt(request, publishRetries);

  let claimed;
  try {
    claimed = await deps.transitionPost(postId, ["queued"], { status: "publishing", claimedAt: deps.clock().toISOString() });
  } catch (error) {
    if (!(error instanceof PostNotQueuedError)) throw error;
    if (error.status === "publishing") return earlierClaim(postId, final, deps);
    return NextResponse.json({ published: false, message: "Post was already handled." });
  }

  let linkedinPostId: string;
  try {
    linkedinPostId = await deps.publishTextPost(claimed.text);
  } catch (error) {
    const message = errorMessage(error);
    if (error instanceof LinkedInPublishError && error.outcome === "rejected") {
      // LinkedIn cannot have it, so it goes back to the queue for QStash to retry. The next
      // automation run retires it if every attempt failed, which is what stops a dead
      // token from looking like pending work.
      await deps.transitionPost(postId, ["publishing"], { status: "queued", claimedAt: undefined, error: message });
      await deps.notifyOperator({
        title: `LinkedIn publish failed (attempt ${attempt})`,
        body: `${message} The post scheduled for ${formatDateTime(claimed.scheduledFor)} is still queued${final ? " and QStash has given up" : " and QStash will retry"}.`,
        priority: final ? 5 : 3,
        link: error.reason === "authorization" ? connectUrl() : undefined,
      });
      return NextResponse.json({ published: false, id: postId, error: message }, { status: 502 });
    }
    await markOutcomeUnknown(postId, claimed.scheduledFor, `LinkedIn did not confirm the post (${message})`, deps);
    return NextResponse.json({ published: "unknown", id: postId, error: message });
  }

  const posted = { status: "posted" as const, postedAt: deps.clock().toISOString(), linkedinPostId, error: undefined };
  // "failed" too: a delivery that gave up on this one as unknown is overruled by LinkedIn's answer.
  const recordPosted = () => deps.transitionPost(postId, ["publishing", "failed"], posted);
  try {
    await recordPosted().catch(recordPosted);
  } catch (error) {
    console.error("Post published but its record could not be updated:", errorMessage(error));
    await deps.notifyOperator({
      title: "LinkedIn published the post, but its record was not updated",
      body: `LinkedIn confirmed the post scheduled for ${formatDateTime(claimed.scheduledFor)} as ${linkedinPostId}. The dashboard may show it as publishing or failed; it went out. (${errorMessage(error)})`,
      priority: 4,
    });
    return NextResponse.json({ published: true, id: postId, linkedinPostId, persisted: false });
  }
  return NextResponse.json({ published: true, id: postId, linkedinPostId });
}

// Another delivery claimed the post and never recorded LinkedIn's answer. While that
// delivery may still be running, QStash is asked to come back; once it cannot be, the
// post may or may not be on LinkedIn, so it is retired with an alert and never resent.
async function earlierClaim(postId: string, final: boolean, deps: PublishDeps) {
  const post = (await deps.listPosts()).find((entry) => entry.id === postId);
  if (!post || post.status !== "publishing") return NextResponse.json({ published: false, message: "Post was already handled." });
  const claimedAt = post.claimedAt ? Date.parse(post.claimedAt) : 0;
  if (!final && deps.clock().getTime() - claimedAt < staleClaimMs) {
    return NextResponse.json({ published: false, message: "Another delivery is publishing this post." }, { status: 503 });
  }
  await markOutcomeUnknown(postId, post.scheduledFor, "A delivery stopped while publishing the post", deps);
  return NextResponse.json({ published: "unknown", id: postId });
}

async function markOutcomeUnknown(postId: string, scheduledFor: string, what: string, deps: PublishDeps) {
  const error = `${what}; it may be live. It will not be retried.`;
  await deps.transitionPost(postId, ["publishing"], { status: "failed", error });
  await deps.notifyOperator({
    title: "Check LinkedIn: a post may have gone out",
    body: `${error} Look for the post scheduled for ${formatDateTime(scheduledFor)} on LinkedIn, and post it by hand only if it is not there.`,
    priority: 5,
  });
}
