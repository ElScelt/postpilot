import { draftViolations } from "./rules";
import type { DraftContext } from "./types";
import { draftJsonProblem, parseDraftDecision, repairDraftJson, type DraftDecision } from "./decision";
import { completeGroq, GroqInvalidJsonError } from "./groq";
import { buildDraftRequest, type RecentActivity } from "./prompt";
import { buildReviewRequest, type PostedDecision } from "./review";
import { searchThemeEvidence, type ResearchResult } from "../research/tavily";
import { focusEvidence, meetsEvidenceBar } from "../research/sources";
import { themeOrder, type PostTheme } from "../research/themes";
import { errorMessage } from "../errors";
import { runTimeLimitSeconds } from "../scheduling/qstash";
import { sleep } from "../scheduling/time";

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
  // Wall-clock limit for the whole night, as an epoch millisecond. The Groq free tier
  // admits about one request of this size a minute, so every extra theme costs up to a
  // minute, and the run must never reach the function's own timeout.
  deadline?: number;
  // How many themes may be drafted, not merely searched, in one run.
  maxThemesDrafted?: number;
};

const maxAttempts = 2;
const defaultMaxThemesDrafted = 3;
const minimumThemeMs = 75_000;

// Drafting gets the run route's time limit less what the run still does afterwards:
// storing and scheduling the post, then up to three ten-second ntfy attempts with their
// waits. Past this deadline the platform would kill the run before it recorded anything.
const finishReserveMs = 45_000;
export const draftingBudgetMs = runTimeLimitSeconds * 1000 - finishReserveMs;

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
export async function generateGroundedDraft(
  recent: RecentActivity,
  now = new Date(),
  fetcher: typeof fetch = fetch,
  options: DraftOptions = {},
): Promise<DraftOutcome> {
  const deadline = options.deadline ?? Date.now() + draftingBudgetMs;
  const bounded = withDeadline(fetcher, deadline);
  const maxThemes = options.maxThemesDrafted ?? defaultMaxThemesDrafted;
  const themesTried: PostTheme[] = [];
  const evidenceHosts: Record<string, string[]> = {};
  const attempts: DraftAttempt[] = [];
  const notes: string[] = [];
  const declined: string[] = [];
  let rejected: DraftRejectedError | undefined;
  let drafted = 0;
  let lastTheme: PostTheme | undefined;
  for (const theme of themeOrder(recent.themes, now)) {
    if (drafted > 0 && (drafted >= maxThemes || Date.now() > deadline - minimumThemeMs)) break;
    themesTried.push(theme);
    const results = await searchThemeEvidence(theme, now, bounded);
    evidenceHosts[theme] = [...new Set(results.map((result) => new URL(result.url).hostname))];
    if (!results.length) continue;
    lastTheme = theme;
    // If the whole evidence set cannot clear the bar, no draft drawn from it can either.
    if (!meetsEvidenceBar(results.map((result) => result.url))) continue;
    drafted += 1;
    const outcome = await draftFromTheme(recent, results, theme, now, bounded, deadline, attempts, notes);
    if (outcome.decision.shouldPost) return { decision: outcome.decision, theme, themesTried, evidenceHosts, attempts, notes };
    if (outcome.rejected) rejected = outcome.rejected;
    else declined.push(`${theme}: ${outcome.decision.reason}`);
  }
  if (rejected) throw new DraftRejectedError(rejected.message, attempts, rejected.theme);
  const reason = declined.length
    ? `No theme had a story worth posting (${declined.join("; ")}).`
    : themesTried.length && Object.values(evidenceHosts).some((hosts) => hosts.length)
      ? `Evidence lacks a first-party source or two credible publishers (tried ${themesTried.join(", ")}).`
      : `No dated recent evidence found (tried ${themesTried.join(", ")}).`;
  return { decision: { shouldPost: false, reason }, theme: lastTheme, themesTried, evidenceHosts, attempts, notes };
}

// Two drafts from one theme's evidence: the second hears every rule the first broke.
async function draftFromTheme(
  recent: RecentActivity,
  results: ResearchResult[],
  theme: PostTheme,
  now: Date,
  fetcher: typeof fetch,
  deadline: number,
  attempts: DraftAttempt[],
  notes: string[],
): Promise<{ decision: DraftDecision; rejected?: DraftRejectedError }> {
  const focused = focusEvidence(results);
  const evidence = focused.map((result) =>
    [result.title, result.url, result.publishedDate, result.content].join("\n"));
  const context: DraftContext = {
    recentPosts: recent.posts,
    recentThemes: recent.previousTheme ? [recent.previousTheme] : [],
    evidence,
  };
  let feedback = "";
  let failedDraft = "";
  let compact = false;
  let reasoning: "medium" | "low" = "medium";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let text: string;
    try {
      text = await completeGroq(
        buildDraftRequest({ recent, results: focused, now, theme, feedback, failedDraft, compact, reasoning }), "draft", fetcher, sleep, deadline,
      );
    } catch (error) {
      const repaired = repairedAnswer(error);
      if (repaired !== undefined) {
        text = repaired;
      } else if (error instanceof GroqInvalidJsonError) {
        // An empty or cut-off answer in strict JSON mode is usually the reasoning
        // spending the whole completion budget, so it is repeated once with low
        // reasoning effort. Complete JSON in the wrong shape would not improve with less
        // thinking; it, and a second failure of any kind, is fed back like an invalid draft.
        if (reasoning === "medium" && !parsesAsJson(error.failedGeneration)) {
          reasoning = "low";
          attempt -= 1;
          continue;
        }
        feedback = draftJsonProblem(error.failedGeneration);
        // The malformed answer itself is not shown again: on a live run the model
        // copied its nested shape straight back.
        failedDraft = "";
        attempts.push({ text: error.failedGeneration, reason: feedback });
        continue;
      } else {
        // The free tier's per-minute token budget is shared by prompt and answer. When
        // Groq refuses the request as too large, the same attempt is repeated once with
        // fewer, shorter excerpts instead of losing the night.
        if (compact || !(error instanceof Error) || !/too large/.test(error.message)) throw error;
        compact = true;
        attempt -= 1;
        continue;
      }
    }
    let decision: DraftDecision;
    try {
      decision = parseDraftDecision(text, focused);
    } catch (error) {
      // A malformed answer gets the same correction as an invalid one; it used to fail
      // the whole night before the model heard what was wrong.
      feedback = errorMessage(error);
      failedDraft = text;
      attempts.push({ text, reason: feedback });
      continue;
    }
    if (!decision.shouldPost) return { decision };
    // The model may relabel the post; the rotation needs the theme actually researched.
    const draft = { ...decision, theme };
    const violations = draftViolations(draft, now, context);
    if (!violations.length) return { decision: await reviewDraft(draft, focused, now, fetcher, deadline, context, notes) };
    feedback = violations.join(" ");
    failedDraft = draft.text;
    attempts.push({ text: draft.text, reason: feedback });
  }
  return { decision: { shouldPost: false, reason: feedback }, rejected: new DraftRejectedError(feedback, attempts, theme) };
}

function parsesAsJson(text: string) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// A strict-JSON refusal whose text only needs its paragraphs unwrapped.
function repairedAnswer(error: unknown) {
  return error instanceof GroqInvalidJsonError ? repairDraftJson(error.failedGeneration) : undefined;
}

// Like the draft, an empty or malformed strict-JSON review is usually the reasoning
// spending the whole completion budget, so it is asked once more with low effort. A
// review that only nested its paragraphs is unwrapped instead.
async function requestReview(draft: PostedDecision, results: ResearchResult[], now: Date, fetcher: typeof fetch, deadline: number) {
  try {
    return await completeGroq(buildReviewRequest(draft, results, now), "review", fetcher, sleep, deadline);
  } catch (error) {
    if (!(error instanceof GroqInvalidJsonError)) throw error;
    const repaired = repairedAnswer(error);
    if (repaired !== undefined) return repaired;
  }
  try {
    return await completeGroq(buildReviewRequest(draft, results, now, "low"), "review", fetcher, sleep, deadline);
  } catch (error) {
    const repaired = repairedAnswer(error);
    if (repaired === undefined) throw error;
    return repaired;
  }
}

// A validated draft is read once more against its evidence and any claim that goes
// beyond it is pulled back. The review can decline the story outright, which counts as
// the theme declining; a review that fails, cannot be parsed or breaks a rule is dropped
// and the validated draft ships, with a note on the run record. It never costs the night.
async function reviewDraft(
  draft: PostedDecision,
  results: ResearchResult[],
  now: Date,
  fetcher: typeof fetch,
  deadline: number,
  context: DraftContext,
  notes: string[],
): Promise<DraftDecision> {
  let text: string;
  try {
    text = await requestReview(draft, results, now, fetcher, deadline);
  } catch (error) {
    notes.push(`Review pass skipped: ${errorMessage(error)}`);
    return draft;
  }
  let reviewed: DraftDecision;
  try {
    reviewed = parseDraftDecision(text, results);
  } catch (error) {
    notes.push(`Review pass answer could not be parsed: ${errorMessage(error)}`);
    return draft;
  }
  if (!reviewed.shouldPost) return reviewed;
  const candidate = { ...reviewed, theme: draft.theme };
  // A source the review dropped as unrelated was propping up the evidence bar. The
  // validated draft must not ship on it, so this counts as the theme declining.
  const dropped = draft.sources.filter((source) => !candidate.sources.some((kept) => kept.url === source.url));
  if (dropped.length && !meetsEvidenceBar(candidate.sources.map((source) => source.url))) {
    return {
      shouldPost: false,
      reason: `Review found a cited source that does not report this story (${dropped.map((source) => source.title).join(", ")}), and the rest cannot clear the evidence bar.`,
    };
  }
  const violations = draftViolations(candidate, now, context);
  if (violations.length) {
    notes.push(`Review rewrite dropped because it broke a rule (${violations.join(" ")}); the validated draft stands.`);
    return draft;
  }
  if (candidate.text !== draft.text) notes.push("Review pass rewrote unsupported claims.");
  return candidate;
}
