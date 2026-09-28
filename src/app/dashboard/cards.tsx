import type { SetupCheck } from "@/lib/setup-check";
import type { QueuedPost } from "@/lib/storage/posts";
import type { AutomationRun } from "@/lib/storage/runs";
import { maxPostLength } from "@/lib/linkedin/api";
import { formatDateTime, formatDay } from "@/lib/scheduling/time";
import { EditForm, RejectForm } from "./forms";
import { levelColor, styles, type Tone } from "./styles";

function statusTone(status: string): Tone {
  if (status === "posted" || status === "scheduled") return "ok";
  if (status === "queued" || status === "publishing" || status === "skipped") return "warn";
  if (status === "failed") return "bad";
  return "idle";
}

export function SetupCard({ checks, ok }: { checks: SetupCheck[]; ok: boolean }) {
  return (
    <section style={{ ...styles.card, marginBottom: "1rem" }}>
      <h2 style={styles.heading}>Setup</h2>
      <p style={{ margin: "0 0 .5rem" }}>
        <span style={styles.badge(ok ? "ok" : "bad")}>
          {ok ? "Everything required is configured." : "Configuration needs attention."}
        </span>
      </p>
      {checks.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
          {checks.map((check, index) => (
            <li key={index} style={{ color: levelColor[check.level], margin: ".25rem 0" }}>{check.text}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function PostCard({ post }: { post: QueuedPost }) {
  return (
    <article style={{ ...styles.card, marginBottom: ".75rem" }}>
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
  );
}

export function RunCard({ run }: { run: AutomationRun }) {
  return (
    <article style={{ ...styles.card, marginBottom: ".75rem" }}>
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
  );
}
