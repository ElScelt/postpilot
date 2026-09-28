import type { NextRequest } from "next/server";
import { cancelPost, listPosts, PostNotQueuedError, type QueuedPost } from "@/lib/storage/posts";
import { errorMessage } from "@/lib/errors";
import { formatDateTime } from "@/lib/scheduling/time";
import { buttonStyle, escapeHtml, invalidLinkPage, page, rejectTarget } from "./html";

// The storage calls the review page makes, injectable so tests drive the handler with
// fakes. route.ts may only export route fields, which is why this lives beside it.
export type RejectDeps = {
  listPosts: typeof listPosts;
  cancelPost: typeof cancelPost;
};

const productionDeps: RejectDeps = { listPosts, cancelPost };

// GET only ever shows the draft. Cancelling on a bare GET would let any prefetch of the
// notification link silently kill a post. The page stays read-only on purpose: the link
// is protected by the ntfy topic name alone, so a leaked topic must never be able to
// rewrite or publish text under the owner's name.
export async function handleReviewPage(request: NextRequest, overrides: Partial<RejectDeps> = {}) {
  const deps = { ...productionDeps, ...overrides };
  const id = rejectTarget(request);
  if (!id) return invalidLinkPage();
  let posts;
  try {
    posts = await deps.listPosts();
  } catch (error) {
    // The Reject button stays: a storage hiccup must not stand between the owner and
    // stopping the post, and the POST reports its own failure if it cannot get through.
    console.error("Review page could not load the draft:", errorMessage(error));
    return page("Draft unavailable", `
      <h1>The draft could not be loaded</h1>
      <p>Reload to try again. You can still reject it without reading it.</p>
      ${rejectForm(request, "Reject this post")}`, 500);
  }
  const post = posts.find((entry) => entry.id === id);
  if (!post) return page("Not found", "<h1>That post no longer exists</h1>");
  if (post.status !== "queued") return alreadyHandledPage(post.status);
  const meta = post.automation
    ? `<p style="color:#52525b">${escapeHtml([post.automation.theme, post.automation.topic].filter(Boolean).join(" · "))}</p>`
    : "";
  const sources = post.automation?.sources.length
    ? `<h2 style="font-size:1rem">Sources</h2><ul>${post.automation.sources.map((source) =>
      `<li><a href="${escapeHtml(source.url)}" rel="noreferrer">${escapeHtml(source.title)}</a> (${escapeHtml(source.publishedDate)})</li>`,
    ).join("")}</ul>`
    : "";
  return page("Review draft", `
    <h1>Publishes ${escapeHtml(formatDateTime(post.scheduledFor))}</h1>
    ${meta}
    <pre style="white-space:pre-wrap;font:inherit;background:#f4f4f5;padding:1rem;border-radius:.5rem">${escapeHtml(post.text)}</pre>
    ${sources}
    ${rejectForm(request, "Reject this post")}`);
}

// A post that is being published can no longer be stopped; saying "already publishing"
// would read as if the Reject might still count.
function alreadyHandledPage(status: QueuedPost["status"]) {
  if (status === "publishing") {
    return page("Too late", "<h1>Too late to reject</h1><p>This post is being published to LinkedIn right now.</p>");
  }
  return page("Already handled", `<h1>Nothing to do</h1><p>This post is already <b>${escapeHtml(status)}</b>.</p>`);
}

function rejectForm(request: NextRequest, label: string) {
  return `<form method="post" action="${escapeHtml(request.nextUrl.pathname + request.nextUrl.search)}">
      <button style="${buttonStyle};background:#b91c1c">${escapeHtml(label)}</button>
    </form>`;
}

export async function handleReject(request: NextRequest, overrides: Partial<RejectDeps> = {}) {
  const deps = { ...productionDeps, ...overrides };
  const id = rejectTarget(request);
  if (!id) return invalidLinkPage();
  try {
    await deps.cancelPost(id);
    // The queued publish message still fires, finds the post is no longer queued, and stops.
    return page("Rejected", "<h1>Rejected</h1><p>This post will not be published.</p>");
  } catch (error) {
    if (error instanceof PostNotQueuedError) {
      return error.status
        ? alreadyHandledPage(error.status)
        : page("Already handled", "<h1>Nothing to do</h1><p>That post no longer exists.</p>");
    }
    // Anything else, typically Redis being unreachable, left the post queued. Saying so
    // with a 500 is what makes the ntfy button report a failure instead of a success.
    console.error("Reject failed:", errorMessage(error));
    return page("Reject failed", `
      <h1>Reject failed, try again</h1>
      <p>The post is still queued and will publish unless the reject goes through.</p>
      ${rejectForm(request, "Try again")}`, 500);
  }
}
