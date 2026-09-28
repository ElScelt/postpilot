import { z } from "zod";
import { mutateStored, versionedStore, type VersionedStore } from "./redis";
import { maxPostLength, publishTimeLimitSeconds } from "../limits";
import type { ResearchSource } from "../drafting/types";

export type AutomationMetadata = {
  topic: string;
  // Absent on posts drafted before theme rotation existed.
  theme?: string;
  sources: ResearchSource[];
};

export type QueuedPost = {
  id: string;
  text: string;
  scheduledFor: string;
  // "publishing" is held from the moment a delivery claims the post until LinkedIn's
  // answer is recorded, so a Reject or an edit can never land in between.
  status: "queued" | "publishing" | "posted" | "cancelled" | "failed";
  createdAt: string;
  // When the review notice reached ntfy. A queued post without it has not been seen
  // by the owner yet, so a retry of the run sends the notice again.
  notifiedAt?: string;
  // When a delivery claimed the post for publishing.
  claimedAt?: string;
  postedAt?: string;
  // Set when the owner rewrote the draft on the dashboard before it went out.
  originalText?: string;
  editedAt?: string;
  linkedinPostId?: string;
  qstashMessageId?: string;
  error?: string;
  automation?: AutomationMetadata;
};

export const postStatuses = ["queued", "publishing", "posted", "cancelled", "failed"] as const satisfies QueuedPost["status"][];

const sourceSchema = z.looseObject({
  title: z.string(), url: z.string(), publishedDate: z.string(), primary: z.boolean(), credible: z.boolean().optional(),
});

// What a stored post must hold for this version to handle it. Loose, so a field it does
// not know, from an older or a newer postpilot, is kept through every change to the post.
export const postSchema = z.looseObject({
  id: z.string(),
  text: z.string(),
  scheduledFor: z.string(),
  status: z.enum(postStatuses),
  createdAt: z.string(),
  notifiedAt: z.string().optional(),
  claimedAt: z.string().optional(),
  postedAt: z.string().optional(),
  originalText: z.string().optional(),
  editedAt: z.string().optional(),
  linkedinPostId: z.string().optional(),
  qstashMessageId: z.string().optional(),
  error: z.string().optional(),
  automation: z.looseObject({ topic: z.string(), theme: z.string().optional(), sources: z.array(sourceSchema) }).optional(),
}) satisfies z.ZodType<QueuedPost>;

// Queued or on its way to LinkedIn: the post may still go out.
export function isLive(post: QueuedPost) {
  return post.status === "queued" || post.status === "publishing";
}

// A delivery that claimed a post is finished or killed once the publish route's time
// limit has passed; a minute on top covers the clocks of two different functions.
export const staleClaimMs = publishTimeLimitSeconds * 1000 + 60_000;

// The store, injectable so tests run without Upstash.
export type PostStoreDeps = {
  store?: VersionedStore;
};

export const queueKey = "postpilot:posts";

// Everything queued stays; the terminal history is capped so the single key never grows
// toward Upstash's request limit. LinkedIn itself is the archive of what went out.
const retainedTerminalPosts = 200;

// Every change is written from what this returns, so a post it cannot read stops the
// read with an error rather than being dropped or rewritten by the next write.
function parsePosts(raw: string | null): QueuedPost[] {
  if (!raw) return [];
  const result = z.array(postSchema).safeParse(JSON.parse(raw));
  if (!result.success) {
    throw new Error(`${queueKey} holds a post this version cannot read, so nothing was changed:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export async function listPosts(deps: PostStoreDeps = {}): Promise<QueuedPost[]> {
  const store = deps.store ?? versionedStore();
  return parsePosts(await store.getRaw(queueKey)).sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
}

// QStash gives up on a delivery within about ninety minutes (four attempts bounded by
// the free plan's fifteen-minute timeout, plus half an hour of backoff), so a post still
// queued long after its slot was never delivered. Anything short of that window may
// still be in flight. A post left publishing by a delivery that was killed is stuck
// once no delivery can still be running; whether LinkedIn has it is unknown.
const abandonedAfterMs = 6 * 60 * 60 * 1000;

export function abandonedPosts(posts: QueuedPost[], now: Date) {
  return posts.filter((post) =>
    (post.status === "queued" && Date.parse(post.scheduledFor) < now.getTime() - abandonedAfterMs)
    || (post.status === "publishing" && Date.parse(post.claimedAt ?? post.scheduledFor) < now.getTime() - staleClaimMs),
  );
}

export function retainPosts(posts: QueuedPost[]) {
  const queued = posts.filter(isLive);
  const terminal = posts.filter((post) => !isLive(post))
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))
    .slice(-retainedTerminalPosts);
  return [...queued, ...terminal].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
}

// Every change to the queue goes through here. The whole queue is one Redis value, so a
// plain read-modify-write let concurrent writers undo each other: a dashboard edit could
// put back a post that a Reject had just cancelled.
function mutatePosts<T>(change: (posts: QueuedPost[]) => T, deps: PostStoreDeps): Promise<T> {
  return mutateStored(deps.store ?? versionedStore(), queueKey, {
    parse: parsePosts,
    serialize: (posts) => JSON.stringify(retainPosts(posts)),
  }, change);
}

export async function addPost(text: string, scheduledFor: string, automation?: AutomationMetadata, deps: PostStoreDeps = {}) {
  const post: QueuedPost = {
    id: crypto.randomUUID(), text, scheduledFor, status: "queued", createdAt: new Date().toISOString(), automation,
  };
  const day = scheduledFor.slice(0, 10);
  return mutatePosts((posts) => {
    if (posts.some((existing) => isLive(existing) && existing.scheduledFor.slice(0, 10) === day)) {
      throw new Error("A LinkedIn post is already queued for that UTC day.");
    }
    posts.push({ ...post });
    return post;
  }, deps);
}

// A change refused because the post has moved on from the states it applies to, usually
// because another request changed it first, or because the history no longer holds it.
// These are the refusals that mean "nothing to do". Every other error, a Redis outage
// above all, must reach the owner as a failure: a Reject that only looks done lets the
// post go out.
export class PostStateError extends Error {
  constructor(readonly id: string, readonly status: QueuedPost["status"] | undefined, message: string) {
    super(message);
    this.name = "PostStateError";
  }
}

// The refusal of a change that needs a queued post: a Reject, an edit, a claim.
export class PostNotQueuedError extends PostStateError {
  constructor(id: string, status?: QueuedPost["status"]) {
    super(id, status, "No queued post exists with that id.");
    this.name = "PostNotQueuedError";
  }
}

// Why a Reject or an edit was refused, worded for the owner. The review page and the
// dashboard both say it, so they say the same thing. A post that is being published can
// no longer be stopped; "already publishing" would read as if the change might still count.
export function notQueuedReason(status?: QueuedPost["status"]) {
  if (status === "publishing") return { title: "Too late", detail: "This post is being published to LinkedIn right now." };
  if (status) return { title: "Nothing to do", detail: `This post is already ${status}.` };
  return { title: "Nothing to do", detail: "That post no longer exists." };
}

function queuedPost(posts: QueuedPost[], id: string) {
  const post = posts.find((item) => item.id === id);
  if (post?.status !== "queued") throw new PostNotQueuedError(id, post?.status);
  return post;
}

// Changes one post, but only while it is in one of the `from` states. Callers name the
// fields they change instead of writing back a whole record read earlier, which would
// undo whatever changed on it in between. A change that needed a queued post throws
// PostNotQueuedError when the post is not queued.
export async function transitionPost(
  id: string,
  from: QueuedPost["status"][],
  patch: Partial<Omit<QueuedPost, "id">>,
  deps: PostStoreDeps = {},
) {
  return mutatePosts((posts) => {
    const post = posts.find((item) => item.id === id);
    if (!post || !from.includes(post.status)) {
      if (from.includes("queued")) throw new PostNotQueuedError(id, post?.status);
      throw new PostStateError(id, post?.status, `Post ${id} is ${post?.status ?? "no longer stored"}, not ${from.join(" or ")}.`);
    }
    return Object.assign(post, patch);
  }, deps);
}

export async function cancelPost(id: string, deps: PostStoreDeps = {}) {
  return transitionPost(id, ["queued"], { status: "cancelled" }, deps);
}

// The owner is the author, so an edit is checked only for being non-empty and inside
// LinkedIn's limit; the voice rules exist to catch the model, not the person.
export async function editPostText(id: string, text: string, deps: PostStoreDeps = {}) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("The post text cannot be empty.");
  if (trimmed.length > maxPostLength) throw new Error(`The post text exceeds ${maxPostLength} characters.`);
  return mutatePosts((posts) => {
    const post = queuedPost(posts, id);
    post.originalText ??= post.text;
    post.text = trimmed;
    post.editedAt = new Date().toISOString();
    return post;
  }, deps);
}
