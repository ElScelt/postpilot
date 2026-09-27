import { redis, type KeyValueStore } from "./redis";
import { errorMessage } from "../errors";

export type AutomationRun = {
  ranAt: string;
  status: "scheduled" | "skipped" | "failed";
  reason?: string;
  warning?: string;
  postId?: string;
  topic?: string;
  // The theme the draft was written from, and every theme searched before it.
  theme?: string;
  themesTried?: string[];
  // Hostnames each theme's search returned, so the run log shows whether the domain
  // allowlist ever yields first-party sources.
  evidenceHosts?: Record<string, string[]>;
  // Drafts the validator rejected on the way, with the rule they tripped.
  attempts?: Array<{ text: string; reason: string }>;
  scheduledFor?: string;
  durationMs?: number;
};

const runsKey = "postpilot:runs";
const retainedRuns = 60;

export async function listAutomationRuns(client: KeyValueStore = redis()): Promise<AutomationRun[]> {
  return (await client.get<AutomationRun[]>(runsKey)) ?? [];
}

// Recording a run must never break the run itself; QStash keeps its own logs for three
// days on the free plan (seven on paid), and this is the only record that outlives them.
export async function recordAutomationRun(run: AutomationRun, client: KeyValueStore = redis()) {
  try {
    const runs = await listAutomationRuns(client);
    await client.set(runsKey, [...runs, run].slice(-retainedRuns));
  } catch (error) {
    console.error("Unable to record automation run:", errorMessage(error));
  }
  return run;
}
