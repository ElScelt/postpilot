import { z } from "zod";
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

// Loose, like the post schema, so fields this version does not know are kept.
export const runSchema = z.looseObject({
  ranAt: z.string(),
  status: z.enum(["scheduled", "skipped", "failed"]),
  reason: z.string().optional(),
  warning: z.string().optional(),
  postId: z.string().optional(),
  topic: z.string().optional(),
  theme: z.string().optional(),
  themesTried: z.array(z.string()).optional(),
  evidenceHosts: z.record(z.string(), z.array(z.string())).optional(),
  attempts: z.array(z.looseObject({ text: z.string(), reason: z.string() })).optional(),
  scheduledFor: z.string().optional(),
  durationMs: z.number().optional(),
}) satisfies z.ZodType<AutomationRun>;

const runsKey = "postpilot:runs";
const retainedRuns = 60;

async function storedRuns(client: Pick<KeyValueStore, "get">): Promise<unknown[]> {
  const stored = await client.get<unknown>(runsKey);
  if (stored === null) return [];
  if (!Array.isArray(stored)) throw new Error(`${runsKey} does not hold a list of runs.`);
  return stored;
}

// The history is a log, so an entry this version cannot read is left out of the list
// rather than hiding every other run, and is kept as it is when a run is recorded.
export async function listAutomationRuns(client: KeyValueStore = redis()): Promise<AutomationRun[]> {
  return (await storedRuns(client)).flatMap((entry) => {
    const result = runSchema.safeParse(entry);
    return result.success ? [result.data] : [];
  });
}

// Recording a run must never break the run itself; QStash keeps its own logs for three
// days on the free plan (seven on paid), and this is the only record that outlives them.
export async function recordAutomationRun(run: AutomationRun, client: KeyValueStore = redis()) {
  try {
    const runs = await storedRuns(client);
    await client.set(runsKey, [...runs, run].slice(-retainedRuns));
  } catch (error) {
    console.error("Unable to record automation run:", errorMessage(error));
  }
  return run;
}
