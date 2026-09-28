import { reconnectWarningDays } from "../linkedin/token";
import { connectPath, connectUrl } from "../linkedin/oauth";
import { formatDateTime } from "../scheduling/time";
import type { Run } from "./run";

const reconnect = `Reconnect at ${connectPath}.`;

const publishRetryWindowMs = 60 * 60 * 1000;

// Drafting against a dead authorization queues a post nothing can publish, so the run
// stops here and its record says so. Retrying cannot fix it, so it is not an error for
// QStash to retry; it is still no post, so the route reports it to the heartbeat as a
// failure. An authorization that is only running out adds a warning and an alert.
export async function checkAuthorization(run: Run) {
  const { now, scheduledFor, deps, warnings } = run;
  const reconnectLink = connectUrl();
  const token = await deps.linkedInTokenStatus(now.getTime());
  if (token.state !== "valid") {
    const reason = token.state === "missing"
      ? `LinkedIn is not connected. ${reconnect}`
      : `LinkedIn authorization expired ${Math.abs(token.daysRemaining)} days ago. ${reconnect}`;
    await deps.notifyOperator({
      title: "LinkedIn posting is stopped", body: `${reason} No post was drafted tonight.`, priority: 5, tags: "rotating_light", link: reconnectLink,
    });
    await run.record({ status: "failed", reason });
    return { status: "stopped" as const, reason };
  }

  // The post goes out twelve hours after this check, so judge the token against the
  // publish instant, plus an hour for QStash's retries of the publish, the last of which
  // lands about half an hour after the first. The draft still queues: an overnight
  // reconnect saves it, whereas refusing the run would forfeit the night outright.
  const atPublish = await deps.linkedInTokenStatus(scheduledFor.getTime() + publishRetryWindowMs);
  if (atPublish.state !== "valid") {
    warnings.push(`LinkedIn authorization expires before the ${formatDateTime(scheduledFor)} publish. ${reconnect}`);
    await deps.notifyOperator({
      title: "Reconnect LinkedIn tonight",
      body: `The authorization expires before tomorrow's ${formatDateTime(scheduledFor)} publish. Reconnect now or the post will not go out.`,
      priority: 5, tags: "rotating_light", link: reconnectLink,
    });
  } else if (token.daysRemaining <= reconnectWarningDays) {
    warnings.push(`LinkedIn authorization expires in ${token.daysRemaining} days. ${reconnect}`);
    await deps.notifyOperator({
      title: `LinkedIn authorization expires in ${token.daysRemaining} days`,
      body: "LinkedIn issues no refresh token, so open the link and approve the consent screen again before it lapses.",
      priority: 3, tags: "hourglass", link: reconnectLink,
    });
  }
  return undefined;
}
