import { listAutomationRuns } from "@/lib/storage/runs";
import { describeLiveSchedule } from "@/lib/scheduling/schedules";
import { checkSetup, type SetupCheck } from "@/lib/setup-check";
import { linkedInTokenStatus, loadLinkedInToken, type TokenStatus } from "@/lib/linkedin/api";
import { listPosts } from "@/lib/storage/posts";
import type { Environment } from "@/lib/env";
import { errorMessage } from "@/lib/errors";

// Everything the dashboard reads, injectable so a test can load it with fakes.
export type DashboardDeps = {
  linkedInTokenStatus: typeof linkedInTokenStatus;
  loadLinkedInToken: typeof loadLinkedInToken;
  listPosts: typeof listPosts;
  listAutomationRuns: typeof listAutomationRuns;
  describeLiveSchedule: typeof describeLiveSchedule;
  env: Environment;
};

const shown = 20;

function settled<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === "fulfilled" ? result.value : fallback;
}

// Every data source is loaded independently so a missing Redis or QStash credential
// becomes a line in the setup card instead of a blank 500. `servingHost` is the host the
// page was requested on, which the setup checks compare with APP_URL.
export async function loadDashboard(now: Date, servingHost: string | undefined, overrides: Partial<DashboardDeps> = {}) {
  const deps: DashboardDeps = {
    linkedInTokenStatus, loadLinkedInToken, listPosts, listAutomationRuns, describeLiveSchedule, env: process.env, ...overrides,
  };
  const [tokenResult, recordResult, postsResult, runsResult, scheduleResult] = await Promise.allSettled([
    deps.linkedInTokenStatus(now.getTime()), deps.loadLinkedInToken(), deps.listPosts(), deps.listAutomationRuns(), deps.describeLiveSchedule(),
  ]);
  const record = settled(recordResult, null);

  const setup: SetupCheck[] = [];
  const storageFailure = [tokenResult, recordResult, postsResult, runsResult].find((result) => result.status === "rejected");
  if (storageFailure?.status === "rejected") setup.push({ level: "error", text: `Redis: ${errorMessage(storageFailure.reason)}` });
  if (scheduleResult.status === "rejected") setup.push({ level: "error", text: `QStash: ${errorMessage(scheduleResult.reason)}` });
  setup.push(...checkSetup(deps.env, { servingHost, memberId: record?.memberId }));

  return {
    token: settled<TokenStatus>(tokenResult, { state: "missing" }),
    record,
    schedule: settled(scheduleResult, undefined),
    setup,
    setupOk: setup.every((check) => check.level !== "error"),
    // Newest first.
    posts: [...settled(postsResult, [])].sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor)).slice(0, shown),
    runs: [...settled(runsResult, [])].reverse().slice(0, shown),
  };
}
