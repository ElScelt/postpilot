import { config } from "../config";

// Every human-facing timestamp and every scheduling decision uses the configured time
// zone: the owner reads the review notification in the evening and the post goes out
// the next morning, both on that clock.

type Formats = { dateTime: Intl.DateTimeFormat; day: Intl.DateTimeFormat; parts: Intl.DateTimeFormat };

const formatsByZone = new Map<string, Formats>();

function formats(timeZone: string): Formats {
  let found = formatsByZone.get(timeZone);
  if (!found) {
    found = {
      dateTime: new Intl.DateTimeFormat("en-GB", {
        timeZone, weekday: "short", day: "2-digit", month: "short",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }),
      day: new Intl.DateTimeFormat("en-GB", {
        timeZone, weekday: "short", day: "2-digit", month: "short", year: "numeric",
      }),
      parts: new Intl.DateTimeFormat("en-CA", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      }),
    };
    formatsByZone.set(timeZone, found);
  }
  return found;
}

export const dayMs = 24 * 60 * 60 * 1000;

// Whole UTC days since the epoch: a counter that moves once a day, for rotating through
// a list so consecutive runs pick different entries.
export function dayIndex(date: Date) {
  return Math.floor(date.getTime() / dayMs);
}

export function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function formatDateTime(value: string | number | Date, timeZone = config().timeZone) {
  return formats(timeZone).dateTime.format(new Date(value));
}

export function formatDay(value: string | number | Date, timeZone = config().timeZone) {
  return formats(timeZone).day.format(new Date(value));
}

export function isoDay(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

// The calendar days a source may be dated: `days` back from now, and one day ahead
// because a publisher east of UTC may date an article tomorrow. Tavily filters by
// calendar day, so the validator judges by calendar day too.
export function recentDays(now: Date, days: number) {
  return { oldest: isoDay(now.getTime() - days * dayMs), latest: isoDay(now.getTime() + dayMs) };
}

export function localParts(date: Date, timeZone = config().timeZone) {
  const parts = formats(timeZone).parts.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"), month: value("month"), day: value("day"),
    hour: value("hour"), minute: value("minute"), second: value("second"),
  };
}

// Working from local calendar parts rather than adding hours keeps a wall-clock hour
// fixed across a DST boundary. The second pass corrects for an offset that changes
// between the naive guess and the real instant.
export function localTimeToUtc(year: number, month: number, day: number, hour: number, timeZone = config().timeZone) {
  const wallTime = Date.UTC(year, month - 1, day, hour);
  let result = wallTime - utcOffset(new Date(wallTime), timeZone);
  result = wallTime - utcOffset(new Date(result), timeZone);
  return new Date(result);
}

function utcOffset(date: Date, timeZone: string) {
  const local = localParts(date, timeZone);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - date.getTime();
}
