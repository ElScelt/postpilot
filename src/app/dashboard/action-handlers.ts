import { cancelPost, editPostText, notQueuedReason, PostNotQueuedError, type PostStoreDeps } from "@/lib/storage/posts";
import { automationUrl, qstash, qstashTimeoutMs } from "@/lib/scheduling/qstash";
import { withTimeout } from "@/lib/async";
import { runRetries } from "@/lib/limits";
import { errorMessage } from "@/lib/errors";

export type ActionResult = { ok: boolean; message: string };

// What the dashboard's server actions need from the request and the outside world.
// actions.ts supplies the real ones; it can only export server actions and needs the
// Next runtime, so the logic lives here where the tests can reach it.
export type ActionDeps = PostStoreDeps & {
  authorized: () => Promise<boolean>;
  publisher: () => Pick<ReturnType<typeof qstash>, "publishJSON">;
  revalidate: () => void;
};

// The proxy already gates /dashboard, but a server action is a POST to a URL, so each
// one checks the same header again rather than trusting the route matcher alone.
async function assertAuthorized(deps: ActionDeps) {
  if (!(await deps.authorized())) throw new Error("Not authorized.");
}

// Enqueues a signed QStash delivery to the run route instead of running inline, so the
// page answers at once and the outcome arrives as a push like any other night. The
// duplicate check in the run keeps a double click harmless.
export async function runNowAction(deps: ActionDeps): Promise<ActionResult> {
  await assertAuthorized(deps);
  try {
    const result = await withTimeout(deps.publisher().publishJSON({
      url: automationUrl(),
      body: {},
      // The same budget as the schedule: with none, the run route took the first failure
      // for a retryable one and never sent the alert.
      retries: runRetries,
      label: "postpilot-run-manual",
    }), qstashTimeoutMs, "QStash");
    deps.revalidate();
    return { ok: true, message: `Run queued (QStash message ${result.messageId}). The draft or the reason arrives on ntfy in a minute or two.` };
  } catch (error) {
    return { ok: false, message: `The run was not queued: ${errorMessage(error)}` };
  }
}

export async function rejectAction(formData: FormData, deps: ActionDeps): Promise<ActionResult> {
  await assertAuthorized(deps);
  try {
    await cancelPost(String(formData.get("id") ?? ""), deps);
    deps.revalidate();
    return { ok: true, message: "Rejected. Run now to draft a different story for the same morning." };
  } catch (error) {
    return refused(error, deps, "Reject failed, the post is still queued");
  }
}

export async function editAction(formData: FormData, deps: ActionDeps): Promise<ActionResult> {
  await assertAuthorized(deps);
  try {
    await editPostText(String(formData.get("id") ?? ""), String(formData.get("text") ?? ""), deps);
    deps.revalidate();
    return { ok: true, message: "Saved. The edited text is what publishes." };
  } catch (error) {
    return refused(error, deps, "Not saved");
  }
}

// A post that moved on since the page loaded is not a failure to retry, so the page is
// refreshed to show where it went. Anything else, typically Redis being unreachable,
// left the post as it was, and the message says so.
function refused(error: unknown, deps: ActionDeps, failure: string): ActionResult {
  if (error instanceof PostNotQueuedError) {
    deps.revalidate();
    const { title, detail } = notQueuedReason(error.status);
    return { ok: false, message: `${title}. ${detail}` };
  }
  return { ok: false, message: `${failure}: ${errorMessage(error)}` };
}
