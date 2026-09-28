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

// Which delivery of a message this is. QStash counts retries in Upstash-Retried, so the
// last one is where alerts belong: a failure QStash will retry is not yet a lost night.
export function deliveryAttempt(request: Request, retries: number) {
  const retried = Number(request.headers.get("upstash-retried") ?? 0);
  return { attempt: retried + 1, final: retried >= retries };
}

export function deliveryTimestamp(scheduledFor: string) {
  return Math.ceil(new Date(scheduledFor).getTime() / 1000);
}
