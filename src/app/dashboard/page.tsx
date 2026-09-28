import { headers } from "next/headers";
import { listAutomationRuns } from "@/lib/storage/runs";
import { config } from "@/lib/config";
import { describeLiveSchedule, nextScheduledRun } from "@/lib/scheduling/schedules";
import { checkSetup, type SetupCheck } from "@/lib/setup-check";
import { linkedInTokenStatus, loadLinkedInToken, maxPostLength, reconnectWarningDays } from "@/lib/linkedin/api";
import { listPosts } from "@/lib/storage/posts";
import { formatDateTime, formatDay } from "@/lib/scheduling/time";
import { ActionButton, EditForm, RejectForm } from "./forms";
import { runNow } from "./actions";
import { errorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const metadata = { title: "postpilot dashboard" };

const shown = 20;

const styles = {
  page: { font: "15px/1.5 system-ui, sans-serif", margin: "0 auto", padding: "1.5rem", maxWidth: "64rem", color: "#18181b" },
  grid: { display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))" },
  card: { border: "1px solid #e4e4e7", borderRadius: ".75rem", padding: "1rem", background: "#fff" },
  heading: { fontSize: "1rem", margin: "0 0 .5rem" },
  muted: { color: "#52525b" },
  pre: { whiteSpace: "pre-wrap", font: "inherit", background: "#f4f4f5", padding: ".75rem", borderRadius: ".5rem", margin: ".5rem 0" },
  badge: (tone: "ok" | "warn" | "bad" | "idle") => ({
    display: "inline-block", padding: ".1rem .5rem", borderRadius: "999px", fontSize: ".85rem",
    background: { ok: "#dcfce7", warn: "#fef3c7", bad: "#fee2e2", idle: "#e4e4e7" }[tone],
    color: { ok: "#166534", warn: "#92400e", bad: "#991b1b", idle: "#3f3f46" }[tone],
  }),
} as const;

const levelColor: Record<SetupCheck["level"], string> = { error: "#991b1b", warning: "#92400e", note: "#52525b" };

function statusTone(status: string): "ok" | "warn" | "bad" | "idle" {
  if (status === "posted" || status === "scheduled") return "ok";
  if (status === "queued" || status === "publishing" || status === "skipped") return "warn";
  if (status === "failed") return "bad";
  return "idle";
}

// Every data source is loaded independently so a missing Redis or QStash credential
// becomes a line in the setup card instead of a blank 500.
function settled<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === "fulfilled" ? result.value : fallback;
}

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
  const [tokenResult, recordResult, postsResult, runsResult, scheduleResult] = await Promise.allSettled([
    linkedInTokenStatus(now.getTime()), loadLinkedInToken(), listPosts(), listAutomationRuns(), describeLiveSchedule(),
  ]);
  const token = settled(tokenResult, { state: "missing" });
  const record = settled(recordResult, null);
  const posts = settled(postsResult, []);
  const runs = settled(runsResult, []);
  const schedule = settled(scheduleResult, undefined);

  const liveChecks: SetupCheck[] = [];
  const storageFailure = [tokenResult, recordResult, postsResult, runsResult].find((result) => result.status === "rejected");
  if (storageFailure?.status === "rejected") liveChecks.push({ level: "error", text: `Redis: ${errorMessage(storageFailure.reason)}` });
  if (scheduleResult.status === "rejected") liveChecks.push({ level: "error", text: `QStash: ${errorMessage(scheduleResult.reason)}` });
  const setup = [...liveChecks, ...checkSetup(process.env, { servingHost, memberId: record?.memberId })];
  const setupOk = setup.every((check) => check.level !== "error");

  const nextRun = nextScheduledRun(now);
  const recentPosts = [...posts].sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor)).slice(0, shown);
  const recentRuns = [...runs].reverse().slice(0, shown);
  const tokenLine = token.state === "missing"
    ? { tone: "bad" as const, text: "LinkedIn is not connected." }
    : token.state === "expired"
      ? { tone: "bad" as const, text: `LinkedIn authorization expired ${Math.abs(token.daysRemaining)} days ago.` }
      : token.daysRemaining <= reconnectWarningDays
        ? { tone: "warn" as const, text: `LinkedIn authorization expires in ${token.daysRemaining} days.` }
        : { tone: "ok" as const, text: `LinkedIn authorization valid for ${token.daysRemaining} more days.` };

  return (
    <main style={styles.page}>
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 1rem" }}>postpilot</h1>

      <section style={{ ...styles.card, marginBottom: "1rem" }}>
        <h2 style={styles.heading}>Setup</h2>
        <p style={{ margin: "0 0 .5rem" }}>
          <span style={styles.badge(setupOk ? "ok" : "bad")}>
            {setupOk ? "Everything required is configured." : "Configuration needs attention."}
          </span>
        </p>
        {setup.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
            {setup.map((check, index) => (
              <li key={index} style={{ color: levelColor[check.level], margin: ".25rem 0" }}>{check.text}</li>
            ))}
          </ul>
        )}
      </section>

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
          <p><a href="/api/auth/linkedin">Reconnect LinkedIn</a></p>
        </div>
        <div style={styles.card}>
          <h2 style={styles.heading}>Schedule</h2>
          <p>Next research run: <b>{formatDateTime(nextRun)}</b> ({settings.timeZone}).</p>
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
      {recentPosts.length === 0 && <p style={styles.muted}>No posts yet.</p>}
      {recentPosts.map((post) => (
        <article key={post.id} style={{ ...styles.card, marginBottom: ".75rem" }}>
          <p style={{ margin: 0 }}>
            <span style={styles.badge(statusTone(post.status))}>{post.status}</span>{" "}
            <b>{formatDateTime(post.scheduledFor)}</b>
            {post.automation && <span style={styles.muted}> · {post.automation.theme ?? "no theme"} · {post.automation.topic}</span>}
            {post.editedAt && <span style={styles.muted}> · edited {formatDay(post.editedAt)}</span>}
          </p>
          <pre style={styles.pre}>{post.text}</pre>
          {post.automation?.sources.length ? (
            <p style={{ ...styles.muted, margin: ".25rem 0" }}>
              Sources:{" "}
              {post.automation.sources.map((source, index) => (
                <span key={source.url}>
                  {index > 0 && ", "}
                  <a href={source.url} rel="noreferrer">{source.title}</a> ({source.publishedDate})
                </span>
              ))}
            </p>
          ) : null}
          {post.linkedinPostId?.startsWith("urn:") && (
            <p style={{ margin: ".25rem 0" }}>
              <a href={`https://www.linkedin.com/feed/update/${post.linkedinPostId}`} rel="noreferrer">Open on LinkedIn</a>
            </p>
          )}
          {post.error && <p style={{ color: "#991b1b", margin: ".25rem 0" }}>{post.error}</p>}
          {post.status === "queued" && (
            <div style={{ display: "grid", gap: ".5rem", marginTop: ".5rem" }}>
              <EditForm id={post.id} text={post.text} maxLength={maxPostLength} />
              <RejectForm id={post.id} />
            </div>
          )}
        </article>
      ))}

      <h2 style={{ fontSize: "1.1rem", margin: "1.5rem 0 .5rem" }}>Runs</h2>
      {recentRuns.length === 0 && <p style={styles.muted}>No runs recorded yet.</p>}
      {recentRuns.map((run) => (
        <article key={run.ranAt} style={{ ...styles.card, marginBottom: ".75rem" }}>
          <p style={{ margin: 0 }}>
            <span style={styles.badge(statusTone(run.status))}>{run.status}</span>{" "}
            <b>{formatDateTime(run.ranAt)}</b>
            {run.theme && <span style={styles.muted}> · {run.theme}</span>}
            {run.durationMs !== undefined && <span style={styles.muted}> · {Math.round(run.durationMs / 1000)} s</span>}
          </p>
          {run.reason && <p style={{ margin: ".25rem 0" }}>{run.reason}</p>}
          {run.warning && <p style={{ ...styles.muted, margin: ".25rem 0" }}>{run.warning}</p>}
          {run.themesTried?.length ? (
            <p style={{ ...styles.muted, margin: ".25rem 0" }}>
              Themes tried: {run.themesTried.join(", ")}.
              {run.evidenceHosts && " Hosts: "}
              {run.evidenceHosts && Object.entries(run.evidenceHosts)
                .map(([theme, hosts]) => `${theme}: ${hosts.length ? hosts.join(", ") : "none"}`).join("; ")}
            </p>
          ) : null}
          {run.attempts?.length ? (
            <details>
              <summary style={styles.muted}>{run.attempts.length} rejected draft{run.attempts.length > 1 ? "s" : ""}</summary>
              {run.attempts.map((attempt, index) => (
                <div key={index}>
                  <p style={{ color: "#991b1b", margin: ".5rem 0 0" }}>{attempt.reason}</p>
                  <pre style={styles.pre}>{attempt.text}</pre>
                </div>
              ))}
            </details>
          ) : null}
        </article>
      ))}
    </main>
  );
}
