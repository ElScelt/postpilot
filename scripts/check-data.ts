// Reads a deployment's post queue, run history and LinkedIn authorization and reports
// whether this version can read them, before the version is deployed over that data.
// It only reads; give it the database's read-only token to make sure of that:
//
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=<read-only token> npm run check:data
//
// The report holds counts, statuses and field names, never a post's text or a token.
import { redis, versionedStore } from "../src/lib/storage/redis";
import { queueKey } from "../src/lib/storage/posts";
import { runsKey } from "../src/lib/storage/runs";
import { tokenKey } from "../src/lib/linkedin/token";
import { errorMessage } from "../src/lib/errors";
import { checkStoredData } from "./stored-data";

async function main() {
  const client = redis();
  const [posts, runs, token] = await Promise.all([
    versionedStore().getRaw(queueKey), client.get(runsKey), client.get(tokenKey),
  ]);
  const reports = checkStoredData({ posts, runs, token });
  for (const report of reports) {
    console.log(`${report.key}: ${report.entries} ${report.entries === 1 ? "entry" : "entries"}`);
    if (Object.keys(report.statuses).length) console.log(`  statuses: ${summary(report.statuses)}`);
    if (Object.keys(report.unknownFields).length) console.log(`  fields this version keeps but does not read: ${summary(report.unknownFields)}`);
    for (const problem of report.problems) console.log(`  cannot read ${problem}`);
    for (const entry of report.skipped) console.log(`  cannot read ${entry} (left off the dashboard and kept; not a problem for deploying)`);
  }
  const readable = reports.every((report) => report.problems.length === 0);
  console.log(readable ? "\nThis version can read everything stored." : "\nThis version cannot read everything stored; do not deploy it over this data.");
  process.exitCode = readable ? 0 : 1;
}

function summary(counts: Record<string, number>) {
  return Object.entries(counts).map(([name, count]) => `${name} ${count}`).join(", ");
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
