"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { authorizeDashboard } from "@/lib/security/dashboard-auth";
import { cancelPost, editPostText } from "@/lib/storage/posts";
import { automationUrl, qstash, qstashTimeoutMs } from "@/lib/scheduling/qstash";
import { withTimeout } from "@/lib/async";
import { runRetries } from "@/lib/limits";
import { errorMessage } from "@/lib/errors";

// The proxy already gates /dashboard, but a server action is a POST to a URL, so each
// one checks the same header again rather than trusting the route matcher alone.
async function assertAuthorized() {
  const requestHeaders = await headers();
  if (!authorizeDashboard(requestHeaders.get("authorization"))) {
    throw new Error("Not authorized.");
  }
}

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

// Enqueues a signed QStash delivery to the run route instead of running inline, so the
// page answers at once and the outcome arrives as a push like any other night. The
// duplicate check in the run keeps a double click harmless.
export async function runNow(): Promise<ActionResult> {
  await assertAuthorized();
  try {
    const result = await withTimeout(qstash().publishJSON({
      url: automationUrl(),
      body: {},
      // The same budget as the schedule: with none, the run route took the first failure
      // for a retryable one and never sent the alert.
      retries: runRetries,
      label: "postpilot-run-manual",
    }), qstashTimeoutMs, "QStash");
    revalidatePath("/dashboard");
    return { ok: true, message: `Run queued (QStash message ${result.messageId}). The draft or the reason arrives on ntfy in a minute or two.` };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

export async function rejectPost(formData: FormData): Promise<ActionResult> {
  await assertAuthorized();
  const id = String(formData.get("id") ?? "");
  try {
    await cancelPost(id);
    revalidatePath("/dashboard");
    return { ok: true, message: "Rejected. Run now to draft a different story for the same morning." };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

export async function editPost(formData: FormData): Promise<ActionResult> {
  await assertAuthorized();
  const id = String(formData.get("id") ?? "");
  const text = String(formData.get("text") ?? "");
  try {
    await editPostText(id, text);
    revalidatePath("/dashboard");
    return { ok: true, message: "Saved. The edited text is what publishes." };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}
