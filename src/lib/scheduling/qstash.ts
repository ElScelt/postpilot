import { Client } from "@upstash/qstash";
import { appUrl, required } from "../env";

// The QStash client takes no abort signal, so every call is wrapped in withTimeout with
// this limit. QStash answers in well under a second; a call still hanging after this
// fails the run, which records why and is retried, instead of running into the route's
// own limit and ending without a record.
export const qstashTimeoutMs = 10_000;

export function qstash() {
  return new Client({ token: required("QSTASH_TOKEN") });
}

export function publishingUrl() {
  return `${appUrl()}/api/cron/publish`;
}

// Message labels, so the QStash console can filter postpilot's deliveries.
export const publishLabel = "postpilot-publish";
export const manualRunLabel = "postpilot-run-manual";

export function automationUrl() {
  return `${appUrl()}/api/automation/run`;
}

// Which delivery of a message this is. QStash counts retries in Upstash-Retried, so the
// last one is where alerts belong: a failure QStash will retry is not yet a lost night.
export function deliveryAttempt(request: Request, retries: number) {
  const retried = Number(request.headers.get("upstash-retried") ?? 0);
  return { attempt: retried + 1, final: retried >= retries };
}

export function deliveryTimestamp(scheduledFor: string) {
  return Math.ceil(new Date(scheduledFor).getTime() / 1000);
}
