import type { generateGroundedDraft } from "../drafting/pipeline";
import type { listPosts, transitionPost } from "../storage/posts";
import type { scheduleDelivery, schedulePost } from "../queue-post";
import type { AutomationRun, recordAutomationRun } from "../storage/runs";
import type { reconcileAutomationSchedules } from "../scheduling/schedules";
import type { linkedInTokenStatus } from "../linkedin/token";
import type { notifyDraftQueued, notifyOperator } from "../notify/ntfy";

// Everything the run touches outside its own logic, so a test can drive the whole
// orchestration with fakes. Production fills in the real modules.
export type AutomationDeps = {
  listPosts: typeof listPosts;
  transitionPost: typeof transitionPost;
  schedulePost: typeof schedulePost;
  scheduleDelivery: typeof scheduleDelivery;
  linkedInTokenStatus: typeof linkedInTokenStatus;
  generateGroundedDraft: typeof generateGroundedDraft;
  reconcileAutomationSchedules: typeof reconcileAutomationSchedules;
  notifyDraftQueued: typeof notifyDraftQueued;
  notifyOperator: typeof notifyOperator;
  recordAutomationRun: typeof recordAutomationRun;
  // A token for this run, or undefined while another run holds the lock.
  acquireRunLock: (key: string, ttlSeconds: number) => Promise<string | undefined>;
  releaseRunLock: (key: string, token: string) => Promise<void>;
  // Where review notices go. Without one, drafts publish unreviewed.
  ntfyTopic: string | undefined;
};

export type RunOptions = {
  // A bearer-authenticated call from a person rather than a QStash firing. Manual runs
  // never repoint the live schedule at whatever host they were sent to.
  manual?: boolean;
  // QStash retries a failed run three times; alerts about a failed draft go out only
  // once the last attempt has failed, so a night that recovers on retry stays quiet.
  finalAttempt?: boolean;
};

// One run as the steps see it. Whichever step ends the run, its record carries the
// warnings gathered so far and the time spent.
export type Run = {
  now: Date;
  scheduledFor: Date;
  options: RunOptions;
  deps: AutomationDeps;
  warnings: string[];
  record: (fields: Omit<AutomationRun, "ranAt" | "warning" | "durationMs">) => Promise<AutomationRun>;
};
