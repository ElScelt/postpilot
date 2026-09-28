import type { QueuedPost } from "./storage/posts";

// Why a Reject or an edit was refused, worded for the owner. The review page and the
// dashboard both say it, so they say the same thing. A post that is being published can
// no longer be stopped; "already publishing" would read as if the change might still count.
export function notQueuedReason(status?: QueuedPost["status"]) {
  if (status === "publishing") return { title: "Too late", detail: "This post is being published to LinkedIn right now." };
  if (status) return { title: "Nothing to do", detail: `This post is already ${status}.` };
  return { title: "Nothing to do", detail: "That post no longer exists." };
}
