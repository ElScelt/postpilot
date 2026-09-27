import { redis, type KeyValueStore } from "./redis";
import { deliveryTimestamp, qstash, publishingUrl } from "../scheduling/qstash";
import type { ResearchSource } from "../drafting/types";
import { errorMessage } from "../errors";

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
  status: "queued" | "posted" | "cancelled" | "failed";
  createdAt: string;
  postedAt?: string;
  // Set when the owner rewrote the draft on the dashboard before it went out.
  originalText?: string;
  editedAt?: string;
  linkedinPostId?: string;
  qstashMessageId?: string;
  error?: string;
  automation?: AutomationMetadata;
};

// The two collaborators the store needs, injectable so tests run without Upstash.
export type PostStoreDeps = {
  store?: KeyValueStore;
  publisher?: Pick<ReturnType<typeof qstash>, "publishJSON">;
};

const queueKey = "linkedin:posts";

// Everything queued stays; the terminal history is capped so the single key never grows
// toward Upstash's request limit. LinkedIn itself is the archive of what went out.
const retainedTerminalPosts = 200;

export async function listPosts(deps: PostStoreDeps = {}): Promise<QueuedPost[]> {
  const store = deps.store ?? redis();
  return ((await store.get<QueuedPost[]>(queueKey)) ?? []).sort((a, b) =>
    a.scheduledFor.localeCompare(b.scheduledFor),
  );
}

// QStash gives up on a delivery within about ninety minutes (four attempts bounded by
// the free plan's fifteen-minute timeout, plus half an hour of backoff), so a post still
// queued long after its slot was never delivered. Anything short of that window may
// still be in flight.
const abandonedAfterMs = 6 * 60 * 60 * 1000;

export function abandonedPosts(posts: QueuedPost[], now: Date) {
  return posts.filter((post) =>
    post.status === "queued"
    && Date.parse(post.scheduledFor) < now.getTime() - abandonedAfterMs,
  );
}

export function retainPosts(posts: QueuedPost[]) {
  const queued = posts.filter((post) => post.status === "queued");
  const terminal = posts.filter((post) => post.status !== "queued")
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))
    .slice(-retainedTerminalPosts);
  return [...queued, ...terminal].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
}

async function save(posts: QueuedPost[], deps: PostStoreDeps) {
  const store = deps.store ?? redis();
  await store.set(queueKey, retainPosts(posts));
}

export async function addPost(text: string, scheduledFor: string, automation?: AutomationMetadata, deps: PostStoreDeps = {}) {
  const posts = await listPosts(deps);
  const day = scheduledFor.slice(0, 10);
  if (posts.some((post) => post.status === "queued" && post.scheduledFor.slice(0, 10) === day)) {
    throw new Error("A LinkedIn post is already queued for that UTC day.");
  }
  const post: QueuedPost = {
    id: crypto.randomUUID(), text, scheduledFor, status: "queued", createdAt: new Date().toISOString(), automation,
  };
  await save([...posts, post], deps);
  return post;
}

export async function schedulePost(text: string, scheduledFor: string, automation?: AutomationMetadata, deps: PostStoreDeps = {}) {
  const post = await addPost(text, scheduledFor, automation, deps);
  try {
    const publisher = deps.publisher ?? qstash();
    const result = await publisher.publishJSON({
      url: publishingUrl(),
      body: { postId: post.id },
      notBefore: deliveryTimestamp(scheduledFor),
      retries: 3,
      label: ["linkedin-post", post.id],
      redact: { body: true },
      // The SDK re-sends a publish whose response was lost; without this id that is a
      // second delivery for the same post at 09:00.
      deduplicationId: post.id,
    });
    post.qstashMessageId = result.messageId;
    await updatePost(post, deps);
    return post;
  } catch (error) {
    post.status = "failed";
    post.error = errorMessage(error);
    await updatePost(post, deps);
    throw error;
  }
}

export async function cancelPost(id: string, deps: PostStoreDeps = {}) {
  const posts = await listPosts(deps);
  const post = posts.find((item) => item.id === id && item.status === "queued");
  if (!post) throw new Error("No queued post exists with that id.");
  post.status = "cancelled";
  await save(posts, deps);
  return post;
}

export async function updatePost(updated: QueuedPost, deps: PostStoreDeps = {}) {
  const posts = await listPosts(deps);
  const index = posts.findIndex((post) => post.id === updated.id);
  if (index === -1) throw new Error("Post no longer exists.");
  posts[index] = updated;
  await save(posts, deps);
}

export const maxPostLength = 3000;

// The owner is the author, so an edit is checked only for being non-empty and inside
// LinkedIn's limit; the voice rules exist to catch the model, not the person.
export async function editPostText(id: string, text: string, deps: PostStoreDeps = {}) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("The post text cannot be empty.");
  if (trimmed.length > maxPostLength) throw new Error(`The post text exceeds ${maxPostLength} characters.`);
  const posts = await listPosts(deps);
  const post = posts.find((item) => item.id === id && item.status === "queued");
  if (!post) throw new Error("No queued post exists with that id.");
  post.originalText ??= post.text;
  post.text = trimmed;
  post.editedAt = new Date().toISOString();
  await save(posts, deps);
  return post;
}
