import { draftViolations } from "./rules";
import type { DraftContext } from "./types";
import { parseDraftDecision, type DraftDecision } from "./decision";
import { completeGroq, GroqInvalidJsonError } from "./groq";
import { buildDraftRequest, type RecentActivity } from "./prompt";
import { buildReviewRequest, type PostedDecision } from "./review";
import { searchThemeEvidence, type ResearchResult } from "../research/tavily";
import { focusEvidence, meetsEvidenceBar } from "../research/sources";
import { themeOrder, type PostTheme } from "../research/themes";
import { errorMessage } from "../errors";

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
const defaultBudgetMs = 240_000;
const minimumThemeMs = 75_000;

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
  const deadline = options.deadline ?? Date.now() + defaultBudgetMs;
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
    const results = await searchThemeEvidence(theme, now, fetcher);
    evidenceHosts[theme] = [...new Set(results.map((result) => new URL(result.url).hostname))];
    if (!results.length) continue;
    lastTheme = theme;
    // If the whole evidence set cannot clear the bar, no draft drawn from it can either.
    if (!meetsEvidenceBar(results.map((result) => result.url))) continue;
    drafted += 1;
    const outcome = await draftFromTheme(recent, results, theme, now, fetcher, attempts, notes);
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
        buildDraftRequest({ recent, results: focused, now, theme, feedback, failedDraft, compact, reasoning }), "draft", fetcher,
      );
    } catch (error) {
      // An empty or malformed answer in strict JSON mode is usually the reasoning
      // spending the whole completion budget. The attempt is repeated once with low
      // reasoning effort; a second failure is fed back like any other invalid draft.
      if (error instanceof GroqInvalidJsonError) {
        if (reasoning === "medium") {
          reasoning = "low";
          attempt -= 1;
          continue;
        }
        feedback = "The previous answer was empty or was not valid JSON for the required schema. Answer with the JSON object only.";
        failedDraft = error.failedGeneration;
        attempts.push({ text: error.failedGeneration, reason: feedback });
        continue;
      }
      // The free tier's per-minute token budget is shared by prompt and answer. When
      // Groq refuses the request as too large, the same attempt is repeated once with
      // fewer, shorter excerpts instead of losing the night.
      if (compact || !(error instanceof Error) || !/too large/.test(error.message)) throw error;
      compact = true;
      attempt -= 1;
      continue;
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
    if (!violations.length) return { decision: await reviewDraft(draft, focused, now, fetcher, context, notes) };
    feedback = violations.join(" ");
    failedDraft = draft.text;
    attempts.push({ text: draft.text, reason: feedback });
  }
  return { decision: { shouldPost: false, reason: feedback }, rejected: new DraftRejectedError(feedback, attempts, theme) };
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
  context: DraftContext,
  notes: string[],
): Promise<DraftDecision> {
  let text: string;
  try {
    text = await completeGroq(buildReviewRequest(draft, results, now), "review", fetcher);
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
  const violations = draftViolations(candidate, now, context);
  if (violations.length) {
    notes.push(`Review rewrite dropped because it broke a rule (${violations.join(" ")}); the validated draft stands.`);
    return draft;
  }
  if (candidate.text !== draft.text) notes.push("Review pass rewrote unsupported claims.");
  return candidate;
}
