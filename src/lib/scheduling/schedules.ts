import { config, weekdays, type Config } from "../config";
import { automationUrl, qstash, runRetries } from "./qstash";
import { dayMs, localParts, localTimeToUtc } from "./time";

type ScheduleSettings = Pick<Config, "timeZone" | "schedule">;
type PublishSettings = Pick<Config, "timeZone" | "publishHour">;

// Creating a schedule with this id again overwrites it in place, so a deployment only
// ever holds one.
export const runScheduleId = "postpilot-run";

export function runCron({ timeZone, schedule }: ScheduleSettings = config()) {
  const days = [...new Set(schedule.days)].map((day) => weekdays.indexOf(day)).sort((a, b) => a - b);
  return `CRON_TZ=${timeZone} 0 ${schedule.runHour} * * ${days.join(",")}`;
}

export function scheduleRequest(destination = automationUrl(), settings: ScheduleSettings = config()) {
  return {
    scheduleId: runScheduleId,
    destination,
    cron: runCron(settings),
    body: "{}",
    headers: { "Content-Type": "application/json" },
    retries: runRetries,
    label: runScheduleId,
  };
}

export type ReconcileOptions = {
  // A run triggered by hand from wherever the secret was pasted. Such a run may create
  // a missing schedule but must never repoint a live one at its own host: a local dev
  // server holding the production QStash token once sent every firing to localhost.
  manual?: boolean;
  settings?: ScheduleSettings;
};

// Every run is QStash-signed and already holds the QStash token, so it can bring the
// live schedule in line with the configuration itself: a schedule change ships with the
// deploy and takes effect on the next run, no hand-run setup call required. Creating
// with an existing scheduleId overwrites in place, so a live schedule is never deleted.
export async function reconcileAutomationSchedules(
  client = qstash(),
  destination = automationUrl(),
  options: ReconcileOptions = {},
) {
  const request = scheduleRequest(destination, options.settings);
  const live = await getIfPresent(client, runScheduleId);
  if (live && sameCron(live.cron, request.cron) && live.destination === request.destination) return [];
  if (live && options.manual && hostOf(live.destination) !== hostOf(request.destination)) {
    return [`${runScheduleId}: live destination ${live.destination} left alone by a manual run from ${request.destination}`];
  }
  await client.schedules.create(request);
  return [live
    ? `${runScheduleId}: ${live.cron} at ${live.destination} -> ${request.cron} at ${request.destination}`
    : `${runScheduleId}: created ${request.cron}`];
}

// The run drafts the evening before so the whole night is a review window, then targets
// the next publish hour that is at least two hours away, so a retry after midnight still
// lands the same morning.
const minimumLeadMs = 2 * 60 * 60 * 1000;

export function scheduledPostTime(now = new Date(), { timeZone, publishHour }: PublishSettings = config()) {
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const local = localParts(new Date(now.getTime() + dayOffset * dayMs), timeZone);
    const target = localTimeToUtc(local.year, local.month, local.day, publishHour, timeZone);
    if (target.getTime() >= now.getTime() + minimumLeadMs) return target;
  }
  return new Date(now.getTime() + minimumLeadMs);
}

// QStash trims and may reformat the stored expression; whitespace must not read as drift.
function sameCron(live: string, wanted: string) {
  const normalize = (cron: string) => cron.trim().split(/\s+/).join(" ");
  return normalize(live) === normalize(wanted);
}

function hostOf(url: string) {
  return URL.canParse(url) ? new URL(url).host : url;
}

async function getIfPresent(client: ReturnType<typeof qstash>, scheduleId: string) {
  try {
    return await client.schedules.get(scheduleId);
  } catch (error) {
    if (hasNotFoundStatus(error)) return undefined;
    throw error;
  }
}

function hasNotFoundStatus(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

// The next instant the schedule fires, read from the configuration so the dashboard and
// the live schedule can never disagree about it.
export function nextScheduledRun(now = new Date(), { timeZone, schedule }: ScheduleSettings = config()) {
  const days = schedule.days.map((day) => weekdays.indexOf(day));
  for (let offset = 0; offset <= 7; offset += 1) {
    const local = localParts(new Date(now.getTime() + offset * dayMs), timeZone);
    const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
    if (!days.includes(weekday)) continue;
    const target = localTimeToUtc(local.year, local.month, local.day, schedule.runHour, timeZone);
    if (target.getTime() > now.getTime()) return target;
  }
  throw new Error("No scheduled run within the next week.");
}

// What the dashboard shows next to the configured cron: whether QStash holds the
// schedule and where it delivers, so a missing or stale schedule is visible before a
// night passes.
export async function describeLiveSchedule(client = qstash()) {
  const live = await getIfPresent(client, runScheduleId);
  return {
    id: runScheduleId,
    cron: runCron(),
    live: live ? { cron: live.cron, destination: live.destination } : undefined,
  };
}
