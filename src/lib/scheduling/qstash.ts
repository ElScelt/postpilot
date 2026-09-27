import { Client } from "@upstash/qstash";
import { appUrl, required } from "../env";

export function qstash() {
  return new Client({ token: required("QSTASH_TOKEN") });
}

export function publishingUrl() {
  return `${appUrl()}/api/cron/publish`;
}

export function automationUrl() {
  return `${appUrl()}/api/automation/run`;
}

export function deliveryTimestamp(scheduledFor: string) {
  return Math.ceil(new Date(scheduledFor).getTime() / 1000);
}
