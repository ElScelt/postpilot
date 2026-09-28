import type { z } from "zod";
import { postSchema, queueKey } from "../src/lib/storage/posts";
import { runSchema, runsKey } from "../src/lib/storage/runs";
import { tokenKey, tokenSchema } from "../src/lib/linkedin/token";

// What a deployment holds in Redis, as the app reads it: the queue as its raw JSON
// string, the runs and the token as the deserialising client returns them.
export type StoredData = { posts: string | null; runs: unknown; token: unknown };

export type KeyReport = {
  key: string;
  entries: number;
  // How many entries carry each status, so an old or unexpected status stands out.
  statuses: Record<string, number>;
  // Field names this version does not know. They are kept, never read.
  unknownFields: Record<string, number>;
  problems: string[];
  // Entries this version cannot read but works around: the run history leaves such a
  // run off the dashboard and keeps it stored, so it does not stand in the way of a deploy.
  skipped: string[];
};

// Checks stored data against the schemas this version reads it with. The report holds
// counts, statuses, field names and schema messages, never a post's text or a token, so
// it can be pasted anywhere.
export function checkStoredData(data: StoredData): KeyReport[] {
  let posts: unknown = null;
  let postsProblem: string | undefined;
  try {
    posts = data.posts === null ? null : JSON.parse(data.posts);
  } catch {
    postsProblem = "not valid JSON";
  }
  const postsReport = checkList(queueKey, posts, postSchema);
  if (postsProblem) postsReport.problems.push(postsProblem);
  const runsReport = checkList(runsKey, data.runs, runSchema);
  if (Array.isArray(data.runs)) [runsReport.skipped, runsReport.problems] = [runsReport.problems, []];
  return [postsReport, runsReport, checkList(tokenKey, data.token, tokenSchema, false)];
}

function checkList(key: string, value: unknown, schema: z.ZodObject, isList = true): KeyReport {
  const report: KeyReport = { key, entries: 0, statuses: {}, unknownFields: {}, problems: [], skipped: [] };
  if (value === null || value === undefined) return report;
  if (isList && !Array.isArray(value)) {
    report.problems.push("not a list");
    return report;
  }
  const entries = isList ? value as unknown[] : [value];
  report.entries = entries.length;
  const known = new Set(Object.keys(schema.shape));
  entries.forEach((entry, index) => {
    const label = isList ? `entry ${index}` : "record";
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      report.problems.push(`${label}: not an object`);
      return;
    }
    const status = (entry as { status?: unknown }).status;
    if (status !== undefined) report.statuses[String(status)] = (report.statuses[String(status)] ?? 0) + 1;
    for (const field of Object.keys(entry).filter((name) => !known.has(name))) {
      report.unknownFields[field] = (report.unknownFields[field] ?? 0) + 1;
    }
    const result = schema.safeParse(entry);
    if (!result.success) {
      for (const issue of result.error.issues) {
        report.problems.push(`${label}: ${issue.path.join(".") || "(record)"}: ${issue.message}`);
      }
    }
  });
  return report;
}
