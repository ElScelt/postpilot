import { Client } from "@upstash/qstash";
import { appUrl, required } from "../env";

// The QStash client takes no abort signal. A hung call is bounded by the route's own
// time limit instead, which the run lock and QStash's retries make recoverable.
export function qstash() {
  return new Client({ token: required("QSTASH_TOKEN") });
}

export function publishingUrl() {
  return `${appUrl()}/api/cron/publish`;
}

export function automationUrl() {
  return `${appUrl()}/api/automation/run`;
}

// Every run, scheduled or started from the dashboard, is retried this many times with a
// fresh sample; the run route alerts only on the last attempt.
export const runRetries = 3;

// The run route's maxDuration. The run lock and the drafting deadline are derived from
// it, so a run that the platform kills leaves nothing behind that outlives it. Next
// reads maxDuration statically, so route.ts repeats the number and a test pins the two.
export const runTimeLimitSeconds = 300;

// Which delivery of a message this is. QStash counts retries in Upstash-Retried, so the
// last one is where alerts belong: a failure QStash will retry is not yet a lost night.
export function deliveryAttempt(request: Request, retries: number) {
  const retried = Number(request.headers.get("upstash-retried") ?? 0);
  return { attempt: retried + 1, final: retried >= retries };
}

export function deliveryTimestamp(scheduledFor: string) {
  return Math.ceil(new Date(scheduledFor).getTime() / 1000);
}
