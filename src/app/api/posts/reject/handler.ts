import type { NextRequest } from "next/server";
import { cancelPost, listPosts } from "@/lib/storage/posts";
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
  const post = (await deps.listPosts()).find((entry) => entry.id === id);
  if (!post) return page("Not found", "<h1>That post no longer exists</h1>");
  if (post.status !== "queued") {
    return page("Already handled", `<h1>Nothing to do</h1><p>This post is already <b>${escapeHtml(post.status)}</b>.</p>`);
  }
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
    <form method="post" action="${escapeHtml(request.nextUrl.pathname + request.nextUrl.search)}">
      <button style="${buttonStyle};background:#b91c1c">Reject this post</button>
    </form>`);
}

export async function handleReject(request: NextRequest, overrides: Partial<RejectDeps> = {}) {
  const deps = { ...productionDeps, ...overrides };
  const id = rejectTarget(request);
  if (!id) return invalidLinkPage();
  try {
    await deps.cancelPost(id);
    // The queued publish message still fires, finds the post is no longer queued, and stops.
    return page("Rejected", "<h1>Rejected</h1><p>This post will not be published.</p>");
  } catch {
    return page("Already handled", "<h1>Nothing to do</h1><p>This post was already published or cancelled.</p>");
  }
}
