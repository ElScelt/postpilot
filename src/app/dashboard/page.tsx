import { headers } from "next/headers";
import { config } from "@/lib/config";
import { nextScheduledRun } from "@/lib/scheduling/schedules";
import { formatDateTime, formatDay } from "@/lib/scheduling/time";
import { errorMessage } from "@/lib/errors";
import { connectPath } from "@/lib/linkedin/oauth";
import { ActionButton } from "./forms";
import { runNow } from "./actions";
import { loadDashboard, tokenSummary } from "./data";
import { PostCard, RunCard, SetupCard } from "./cards";
import { levelColor, styles } from "./styles";

export const dynamic = "force-dynamic";
export const metadata = { title: "postpilot dashboard" };

// Everything below formats times and reads the schedule from the configuration, so an
// invalid postpilot.config.ts is reported on its own instead of as a blank 500.
function ConfigError({ message }: { message: string }) {
  return (
    <main style={styles.page}>
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 1rem" }}>postpilot</h1>
      <section style={styles.card}>
        <h2 style={styles.heading}>Setup</h2>
        <p><span style={styles.badge("bad")}>Configuration needs attention.</span></p>
        <pre style={{ ...styles.pre, color: levelColor.error }}>{message}</pre>
      </section>
    </main>
  );
}

export default async function Dashboard() {
  let settings;
  try {
    settings = config();
  } catch (error) {
    return <ConfigError message={errorMessage(error)} />;
  }
  const now = new Date();
  const requestHeaders = await headers();
  const servingHost = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? undefined;
  const { token, record, schedule, setup, setupOk, posts, runs } = await loadDashboard(now, servingHost);
  const tokenLine = tokenSummary(token);

  return (
    <main style={styles.page}>
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 1rem" }}>postpilot</h1>

      <SetupCard checks={setup} ok={setupOk} />

      <section style={styles.grid}>
        <div style={styles.card}>
          <h2 style={styles.heading}>Authorization</h2>
          <p><span style={styles.badge(tokenLine.tone)}>{tokenLine.text}</span></p>
          {record && (
            <p style={styles.muted}>
              Connected as member <b>{record.memberId}</b>
              {record.connectedAt ? ` on ${formatDay(record.connectedAt)}` : ""}; expires {formatDay(record.expiresAt)}.
            </p>
          )}
          <p><a href={connectPath}>Reconnect LinkedIn</a></p>
        </div>
        <div style={styles.card}>
          <h2 style={styles.heading}>Schedule</h2>
          <p>Next research run: <b>{formatDateTime(nextScheduledRun(now))}</b> ({settings.timeZone}).</p>
          <p style={styles.muted}>
            Posts publish at {String(settings.publishHour).padStart(2, "0")}:00 ({settings.timeZone}) after each run.
          </p>
          {schedule && (
            <p style={styles.muted}>
              {schedule.live
                ? `QStash schedule ${schedule.id}: ${schedule.live.cron}, delivering to ${schedule.live.destination}.`
                : `QStash schedule ${schedule.id} does not exist yet; the first run creates it.`}
            </p>
          )}
          <ActionButton action={runNow} label="Run now" tone="primary" />
        </div>
      </section>

      <h2 style={{ fontSize: "1.1rem", margin: "1.5rem 0 .5rem" }}>Posts</h2>
      {posts.length === 0 && <p style={styles.muted}>No posts yet.</p>}
      {posts.map((post) => <PostCard key={post.id} post={post} />)}

      <h2 style={{ fontSize: "1.1rem", margin: "1.5rem 0 .5rem" }}>Runs</h2>
      {runs.length === 0 && <p style={styles.muted}>No runs recorded yet.</p>}
      {runs.map((run) => <RunCard key={run.ranAt} run={run} />)}
    </main>
  );
}
