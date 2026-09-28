import type { QueuedPost } from "../storage/posts";
import type { RecentActivity } from "../drafting/prompt";
import { dayMs } from "../scheduling/time";

const recentWindowMs = 14 * dayMs;

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
