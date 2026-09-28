import { errorMessage } from "../errors";

// A dead-man's switch for the run itself. Alerts can only fire from a run that started;
// a deleted schedule, rotated signing keys or a broken deploy produce silence. Pointing
// HEALTHCHECK_URL at a healthchecks.io check scheduled for the same three evenings turns
// that silence into a push. Optional, and never allowed to affect the run.
export async function pingHeartbeat(
  ok: boolean,
  url = process.env.HEALTHCHECK_URL,
  fetcher: typeof fetch = fetch,
) {
  if (!url) return false;
  const target = ok ? url : `${url.replace(/\/$/, "")}/fail`;
  try {
    const response = await fetcher(target, { method: "GET", signal: AbortSignal.timeout(10_000) });
    return response.ok;
  } catch (error) {
    console.error("Heartbeat ping failed:", errorMessage(error));
    return false;
  }
}
