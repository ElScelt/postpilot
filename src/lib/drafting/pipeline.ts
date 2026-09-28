import { draftViolations } from "./rules";
import type { DraftContext, DraftRun, DraftSettings } from "./types";
import { draftJsonProblem, parseDraftDecision, repairedAnswer, type DraftDecision } from "./decision";
import { completeGroq, GroqInvalidJsonError, GroqRequestTooLargeError } from "./groq";
import { buildDraftRequest, type RecentActivity } from "./prompt";
import { reviewDraft } from "./review";
import { searchThemeEvidence, type ResearchResult } from "../research/tavily";
import { focusEvidence, meetsEvidenceBar } from "../research/sources";
import { themeIds, themeOrder, type PostTheme } from "../research/themes";
import { config } from "../config";
import { errorMessage } from "../errors";
import { runTimeLimitSeconds } from "../limits";

export type DraftAttempt = { text: string; reason: string };

export type DraftOutcome = {
  decision: DraftDecision;
  // The theme whose evidence the draft was written from; undefined when no theme had any.
  theme?: PostTheme;
  themesTried: PostTheme[];
  // Hostnames Tavily returned per theme, so the run record shows whether the domain
  // allowlist ever yields first-party sources.
  evidenceHosts: Record<string, string[]>;
  // Every draft the validator rejected, kept so a failed night can be studied.
  attempts: DraftAttempt[];
  // What the review pass did, or why it could not run; surfaced as a run warning.
  notes?: string[];
};

// A draft that failed validation twice. The attempts travel with the error so the run
// record keeps the rejected text and not just the last rule it tripped.
export class DraftRejectedError extends Error {
  constructor(message: string, readonly attempts: DraftAttempt[], readonly theme: PostTheme) {
    super(message);
    this.name = "DraftRejectedError";
  }
}

export type DraftOptions = {
  now?: Date;
  // Every Tavily and Groq request goes through this; tests and the offline draft pass
  // canned answers.
  fetcher?: typeof fetch;
  // Wall-clock limit for the whole night, as an epoch millisecond. The Groq free tier
  // admits about one request of this size a minute, so every extra theme costs up to a
  // minute, and the run must never reach the function's own timeout. The run passes
  // its own (draftingBudgetMs in automation/draft.ts); a local draft gets the route's limit.
  deadline?: number;
  // How many themes may be drafted, not merely searched, in one run.
  maxThemesDrafted?: number;
  settings?: DraftSettings;
};

const maxAttempts = 2;
const defaultMaxThemesDrafted = 3;
const minimumThemeMs = 75_000;

// Every Tavily and Groq request also ends at the deadline, whatever its own timeout, so
// one slow answer cannot carry the run past it.
function withDeadline(fetcher: typeof fetch, deadline: number): typeof fetch {
  return (input, init) => {
    const remaining = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
    return fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, remaining]) : remaining });
  };
}

// Search the least recently used theme first. A theme is skipped when its evidence
// cannot clear the bar, when the model declines it as not worth a post, or when two
// drafts fail validation; the next theme with evidence is tried before the night is
// given up. The first production night stopped after one theme because the model
// declined a set of DOM documentation returned for a backend query, and five themes
// with real news went untried.
export async function generateGroundedDraft(recent: RecentActivity, options: DraftOptions = {}): Promise<DraftOutcome> {
  const now = options.now ?? new Date();
  const deadline = options.deadline ?? Date.now() + runTimeLimitSeconds * 1000;
  const settings = options.settings ?? config();
  const run: DraftRun = { now, deadline, settings, fetcher: withDeadline(options.fetcher ?? fetch, deadline) };
  const maxThemes = options.maxThemesDrafted ?? defaultMaxThemesDrafted;
  const themesTried: PostTheme[] = [];
  const evidenceHosts: Record<string, string[]> = {};
  const attempts: DraftAttempt[] = [];
  const notes: string[] = [];
  const declined: string[] = [];
  let rejected: { reason: string; theme: PostTheme } | undefined;
  let drafted = 0;
  let lastTheme: PostTheme | undefined;
  for (const theme of themeOrder(recent.themes, now, themeIds(settings.themes))) {
    if (drafted > 0 && (drafted >= maxThemes || Date.now() > deadline - minimumThemeMs)) break;
    themesTried.push(theme);
    const results = await searchThemeEvidence(theme, now, run.fetcher, settings);
    evidenceHosts[theme] = [...new Set(results.map((result) => new URL(result.url).hostname))];
    if (!results.length) continue;
    lastTheme = theme;
    // If the whole evidence set cannot clear the bar, no draft drawn from it can either.
    if (!meetsEvidenceBar(results.map((result) => result.url), settings.evidence)) continue;
    drafted += 1;
    const outcome = await draftFromTheme(recent, results, theme, run);
    attempts.push(...outcome.attempts);
    notes.push(...outcome.notes);
    if (outcome.decision.shouldPost) return { decision: outcome.decision, theme, themesTried, evidenceHosts, attempts, notes };
    if (outcome.rejected) rejected = { reason: outcome.decision.reason, theme };
    else declined.push(`${theme}: ${outcome.decision.reason}`);
  }
  if (rejected) throw new DraftRejectedError(rejected.reason, attempts, rejected.theme);
  const reason = declined.length
    ? `No theme had a story worth posting (${declined.join("; ")}).`
    : themesTried.length && Object.values(evidenceHosts).some((hosts) => hosts.length)
      ? `Evidence lacks a first-party source or two credible publishers (tried ${themesTried.join(", ")}).`
      : `No dated recent evidence found (tried ${themesTried.join(", ")}).`;
  return { decision: { shouldPost: false, reason }, theme: lastTheme, themesTried, evidenceHosts, attempts, notes };
}

type ThemeOutcome = {
  decision: DraftDecision;
  // Both drafts broke a rule; the decision's reason is the last rejection.
  rejected: boolean;
  attempts: DraftAttempt[];
  notes: string[];
};

// Two drafts from one theme's evidence: the second hears every rule the first broke.
async function draftFromTheme(
  recent: RecentActivity,
  results: ResearchResult[],
  theme: PostTheme,
  run: DraftRun,
): Promise<ThemeOutcome> {
  const { now, settings } = run;
  const focused = focusEvidence(results, settings.evidence);
  const evidence = focused.map((result) =>
    [result.title, result.url, result.publishedDate, result.content].join("\n"));
  const context: DraftContext = {
    recentPosts: recent.posts,
    recentThemes: recent.previousTheme ? [recent.previousTheme] : [],
    evidence,
  };
  const attempts: DraftAttempt[] = [];
  let feedback = "";
  let failedDraft = "";
  let form: RequestForm = { compact: false, reasoning: "medium" };
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const answer = await requestDraft(
      (request) => buildDraftRequest({ recent, results: focused, now, theme, feedback, failedDraft, ...request }, settings), form, run,
    );
    form = answer.form;
    if (answer.invalidJson !== undefined) {
      feedback = draftJsonProblem(answer.invalidJson);
      // The malformed answer itself is not shown again: on a live run the model
      // copied its nested shape straight back.
      failedDraft = "";
      attempts.push({ text: answer.invalidJson, reason: feedback });
      continue;
    }
    let decision: DraftDecision;
    try {
      decision = parseDraftDecision(answer.text, focused, settings);
    } catch (error) {
      // A malformed answer gets the same correction as an invalid one; it used to fail
      // the whole night before the model heard what was wrong.
      feedback = errorMessage(error);
      failedDraft = answer.text;
      attempts.push({ text: answer.text, reason: feedback });
      continue;
    }
    if (!decision.shouldPost) return { decision, rejected: false, attempts, notes: [] };
    // The model may relabel the post; the rotation needs the theme actually researched.
    const draft = { ...decision, theme };
    const violations = draftViolations(draft, now, context, settings);
    if (!violations.length) {
      const review = await reviewDraft(draft, focused, context, run);
      return { decision: review.decision, rejected: false, attempts, notes: review.note ? [review.note] : [] };
    }
    feedback = violations.join(" ");
    failedDraft = draft.text;
    attempts.push({ text: draft.text, reason: feedback });
  }
  return { decision: { shouldPost: false, reason: feedback }, rejected: true, attempts, notes: [] };
}

// How a draft request is sent. Each field only ever moves one way, to the lighter form,
// and stays there for the rest of the theme.
type RequestForm = { compact: boolean; reasoning: "medium" | "low" };

// Asks for one draft. A request Groq could not answer is repeated in a lighter form
// instead of using up a draft:
//   - an empty or cut-off answer in strict JSON mode is usually the reasoning spending
//     the whole completion budget, so it is asked again with low reasoning effort;
//   - the free tier's per-minute token budget is shared by prompt and answer, so a
//     request refused as too large is asked again with fewer, shorter excerpts.
// Complete JSON in the wrong shape would not improve with less thinking; it, and a
// second empty answer, come back as invalidJson to be fed back like an invalid draft.
async function requestDraft(
  build: (form: RequestForm) => RequestInit,
  form: RequestForm,
  run: DraftRun,
): Promise<{ form: RequestForm; text: string; invalidJson?: undefined } | { form: RequestForm; invalidJson: string }> {
  for (;;) {
    try {
      return { form, text: await completeGroq(build(form), "draft", { fetcher: run.fetcher, deadline: run.deadline }) };
    } catch (error) {
      const repaired = repairedAnswer(error);
      if (repaired !== undefined) return { form, text: repaired };
      const lighter = lighterForm(form, error);
      if (lighter) {
        form = lighter;
        continue;
      }
      if (error instanceof GroqInvalidJsonError) return { form, invalidJson: error.failedGeneration };
      throw error;
    }
  }
}

function lighterForm(form: RequestForm, error: unknown): RequestForm | undefined {
  if (error instanceof GroqInvalidJsonError) {
    return form.reasoning === "medium" && !parsesAsJson(error.failedGeneration) ? { ...form, reasoning: "low" } : undefined;
  }
  if (!form.compact && error instanceof GroqRequestTooLargeError) return { ...form, compact: true };
  return undefined;
}

function parsesAsJson(text: string) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
