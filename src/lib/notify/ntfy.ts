import { formatDateTime, sleep } from "../scheduling/time";
import { rejectToken } from "../security/reject-token";
import { envValue } from "../env";
import { errorMessage } from "../errors";

export type NtfyMessage = {
  topic: string;
  title: string;
  body: string;
  // ntfy priorities: 1 (min) to 5 (max). 3 is the default.
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string;
  // Opened when the notification itself is tapped.
  click?: string;
  // ntfy action buttons in the simple format ("http, Reject, <url>, method=POST").
  actions?: string[];
};

// ntfy.sh by default; NTFY_URL points at a self-hosted server and NTFY_TOKEN adds the
// access token a reserved or self-hosted topic needs, so the topic name stops being the
// only secret for owners who pay or self-host.
export function ntfyRequest(message: NtfyMessage) {
  const headers: Record<string, string> = {
    "Title": message.title,
    "Priority": String(message.priority ?? 3),
  };
  if (message.tags) headers.Tags = message.tags;
  if (message.click) headers.Click = message.click;
  if (message.actions?.length) headers.Actions = message.actions.join("; ");
  const token = envValue("NTFY_TOKEN");
  if (token) headers.Authorization = `Bearer ${token}`;
  const base = (envValue("NTFY_URL") ?? "https://ntfy.sh").replace(/\/$/, "");
  return {
    url: `${base}/${message.topic}`,
    init: { method: "POST", headers, body: message.body } satisfies RequestInit,
  };
}

const retryDelaysMs = [1000, 3000];
// ntfy answers in well under a second; a request still hanging after this is retried
// rather than left to eat the run's time budget.
const requestTimeoutMs = 10_000;

// A notification failure must never cost the post that was already scheduled, so this
// never throws. It does retry on the transient statuses, because losing the overnight
// notice means a draft publishes unreviewed at 09:00.
export async function sendNtfy(
  message: NtfyMessage,
  fetcher: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<void> = sleep,
) {
  const { url, init } = ntfyRequest(message);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
      if (response.ok) return true;
      if (attempt >= retryDelaysMs.length || (response.status < 500 && response.status !== 429)) {
        console.error(`Unable to send ntfy notification "${message.title}": ntfy responded ${response.status}`);
        return false;
      }
    } catch (error) {
      if (attempt >= retryDelaysMs.length) {
        console.error(`Unable to send ntfy notification "${message.title}":`, errorMessage(error));
        return false;
      }
    }
    await wait(retryDelaysMs[attempt] ?? 0);
  }
}

export type DraftNotice = {
  postId: string;
  text: string;
  scheduledFor: string;
  topic: string;
  appUrl: string;
};

export function rejectUrl(notice: Pick<DraftNotice, "postId" | "appUrl">) {
  const id = encodeURIComponent(notice.postId);
  return `${notice.appUrl.replace(/\/$/, "")}/api/posts/reject?id=${id}&token=${rejectToken(notice.postId)}`;
}

// The http action rejects straight from the notification on both platforms; iOS ignores
// clear=true (binwiederhier/ntfy#1728), so the view action and the tap target open the
// review page, which is where an iPhone owner sees that the reject took effect.
function reviewActions(url: string) {
  return [`http, Reject, ${url}, method=POST, clear=true`, `view, Read and decide, ${url}`];
}

export function draftMessage(notice: DraftNotice): NtfyMessage {
  const url = rejectUrl(notice);
  return {
    topic: notice.topic,
    title: `LinkedIn draft publishes ${formatDateTime(notice.scheduledFor)}`,
    tags: "memo",
    click: url,
    actions: reviewActions(url),
    body: notice.text,
  };
}

export async function notifyDraftQueued(notice: DraftNotice, fetcher: typeof fetch = fetch) {
  return sendNtfy(draftMessage(notice), fetcher);
}

// Operator alerts ride the same topic as the review notices. Before these existed every
// failure, skipped night and expiring token was written to a Redis key nobody reads, and
// the first sign of a dead authorization was weeks of silence.
export type OperatorAlert = {
  title: string;
  body: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string;
  // A link the notification opens, typically the reconnect page.
  link?: string;
};

export async function notifyOperator(
  alert: OperatorAlert,
  topic = envValue("NTFY_TOPIC"),
  fetcher: typeof fetch = fetch,
) {
  if (!topic) return false;
  return sendNtfy({
    topic,
    title: alert.title,
    body: alert.body,
    priority: alert.priority ?? 4,
    tags: alert.tags ?? "warning",
    click: alert.link,
    actions: alert.link ? [`view, Open, ${alert.link}`] : undefined,
  }, fetcher);
}
