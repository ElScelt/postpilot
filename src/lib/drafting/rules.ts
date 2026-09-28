import { config, type Config } from "../config";
import { meetsEvidenceBar } from "../research/sources";
import { recentDays } from "../scheduling/time";
import { maxPostLength } from "../limits";
import { experienceClaim, inventedHistory } from "./claims";
import { firstParagraph, lastParagraph, openingWords } from "./text";
import { spelledNumbers, unsupportedNumbers } from "./numbers";
import type { Draft, DraftContext, DraftSettings, ResearchSource } from "./types";

// The word lists and phrases are exported so the prompt quotes exactly what the
// validator enforces; two hand-kept copies drifted apart before.
export const freshnessWords = [
  "just", "today", "yesterday", "this week", "this month", "this year", "earlier this year",
  "recently", "latest", "brand-new", "newly", "right now",
];
const freshnessClaim = new RegExp(
  `\\b(${freshnessWords.map((word) => word.replace("-", "[- ]")).join("|")})\\b`, "i",
);

export const bannedQuestionOpener = "How do you balance";
const bannedQuestionOpening = new RegExp(`^${bannedQuestionOpener}\\b`, "i");
const genericQuestion = /^(what do you think|thoughts|any thoughts|agree)\?$/i;

// Prose paragraphs end in punctuation and sentences are separated by it. A queued post
// on the first live test read "announced in August 2024 The same source notes..." with
// every full stop missing. A lowercase word or a figure followed by a capitalised
// sentence opener and a lowercase word is a missing full stop; titles stay capitalised
// on both sides and are not matched. Checklist lines (a paragraph of several lines) and
// the hook, which reads as a headline, may end without one.
const missingSentenceBreak = /(?:\b[a-z][\w'’-]*|\b\d[\d.,%]*)\s+(?:The|This|That|These|Those|It|We|You|But|So|If|When)(?=\s+[a-z])/;
const terminalPunctuation = /[.!?:;)"'”’]$/;

// Compounds the model writes unhyphenated or run together. "trade off" is a verb and
// fine; after an article it is the noun and needs its hyphen.
const brokenCompound = /\badhoc\b|\b(?:a|the|this|that|each|every|one)\s+trade\s+offs?\b/i;

// The reader sees the post, never the research. "Both sources were published in late
// August 2026" is the model reporting its homework.
const researchCommentary = /\b(?:both|the|these|those|two|three|my|our)\s+(?:sources|evidence|excerpts)\b|\b(?:was|were)\s+published\b|\bpublished\s+(?:in|on)\s+(?:late|early|mid)\b/i;

// LinkedIn renders commentary as plain text; every reserved character is escaped before
// publishing, so "* item" and "**bold**" reach the reader as typed.
const markdownMarkup = /(?:^|\n)\s*(?:[*•#]+\s)|\s\*\s|\*\*|`/;

const citationPlaceholder = /\((?:source|sources|link)\)|\[(?:source|sources|link|\d+)\]/i;

// "(NVIDIA, Aug 24 2026)", "(NVIDIA, 24 Aug 2026)" and "(NVIDIA, August 2026)" are
// citation formats nobody uses on LinkedIn.
const month = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\\w*\\.?";
const academicCitation = new RegExp(
  `\\([A-Z][\\w.& -]{1,40},\\s*(?:${month}\\s+\\d{1,2},?\\s*\\d{4}|\\d{1,2}\\s+${month},?\\s*\\d{4}|${month}\\s+\\d{4})\\)`, "i",
);

// The prompt keeps URLs in sourceUrls, and LinkedIn linkifies anything that looks like
// one, so a link in the body is either the model ignoring the rule or an injected
// promotion. Handles and hashtags are not checked: escapeCommentary neutralises @ and #,
// and scoped package names such as @tanstack/react-query are everyday vocabulary here.
const linkOrEmail = /https?:\/\/|\bwww\.|[\w.+-]+@[\w-]+\.[a-z]{2,}/i;

type RuleSettings = DraftSettings;

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A space or hyphen inside a configured term matches either or neither, so "data center"
// also catches "data-center" and "datacenter".
function termPattern(term: string) {
  return escapeRegExp(term).replace(/[- ]/g, "[- ]?");
}

// Ban "From a backend perspective" and the model answers with "For a TypeScript backend
// that..." instead. The stack should show through the decision, never through a
// paragraph announcing it.
function stackCostumePattern(stack: string[]) {
  const stackOpener = stack.length ? `^(?:for|in|on) an? (?:${stack.map(termPattern).join("|")})(?!\\w)|` : "";
  return new RegExp(`${stackOpener}^from an? [^.\\n]{0,40}\\bperspective\\b`, "im");
}

// The author writes at the scale the persona describes. A few posts deciding hardware
// procurement or GPU fleets make a developer's feed read as an infrastructure engineer's,
// so the persona's avoided topics are rejected along with their plural and suffixed forms.
function avoidedTopicPattern(avoidTopics: string[]) {
  if (!avoidTopics.length) return undefined;
  return new RegExp(`(?<!\\w)(?:${avoidTopics.map(termPattern).join("|")})\\w*`, "i");
}

// What every check reads: the post and its parts, and what it is judged against.
type DraftParts = RuleSettings & {
  draft: Draft;
  text: string;
  hook: string;
  question: string;
  now: Date;
  context: DraftContext;
};

// A check returns its violations, one or several, or nothing when the draft passes it.
type Check = (parts: DraftParts) => string | string[] | undefined;

// The checks that are one pattern and one message. The first pattern that matches the
// chosen part of the post is quoted back to the model.
function patternCheck(
  pattern: RegExp | readonly RegExp[] | ((parts: DraftParts) => RegExp | undefined),
  message: (match: string) => string,
  part: "text" | "hook" | "question" = "text",
): Check {
  return (parts) => {
    const patterns = typeof pattern === "function" ? [pattern(parts)] : [pattern].flat();
    for (const candidate of patterns) {
      const match = candidate && parts[part].match(candidate);
      if (match) return message(match[0]);
    }
    return undefined;
  };
}

// In the order the violations are reported.
const checks: Check[] = [
  patternCheck(freshnessClaim, (match) => `Draft contains an unverified freshness claim ("${match}").`),
  patternCheck(experienceClaim, (match) => `Hook claims personal testing or usage the evidence cannot support ("${match}"); state a decision or position instead.`, "hook"),
  ({ hook, limits }) => hook.length > limits.maxHookLength
    ? `Hook is ${hook.length} characters; keep it under ${limits.maxHookLength} so it is not cut before "see more" on a phone.`
    : undefined,
  patternCheck(/^topic:/im, () => "Draft must not contain a Topic label."),
  // Em-dashes are the loudest generated-text tell on LinkedIn.
  patternCheck(/[—–]/, () => "Draft contains an em-dash or en-dash; rewrite with commas or plain connectors."),
  patternCheck(citationPlaceholder, (match) => `Draft contains a citation placeholder ("${match}"); state the publisher by name or drop the reference.`),
  patternCheck(academicCitation, (match) => `Draft contains an inline academic citation ("${match}"); name the publisher inside the sentence instead.`),
  patternCheck(linkOrEmail, (match) => `Draft contains a link or e-mail address ("${match}"); name the publisher in the sentence and keep URLs in sourceUrls.`),
  patternCheck(inventedHistory, (match) => `Draft states invented history ("${match}"); say what you would do or verify, and write "if your app..." rather than describing your own system as fact.`),
  patternCheck(researchCommentary, (match) => `Draft talks about its research ("${match}"); the reader sees the post, not the sources.`),
  patternCheck(markdownMarkup, (match) => `Draft contains markup LinkedIn shows literally ("${match.trim() || "*"}"); write plain text with one checklist item per line and no bullet characters.`),
  patternCheck(({ persona }) => stackCostumePattern(persona.stack), (match) => `Draft announces the stack in a paragraph opener ("${match}"); let the stack show through the decision instead.`),
  patternCheck(({ persona }) => avoidedTopicPattern(persona.avoidTopics), (match) => `Draft makes an infrastructure decision outside the author's scale ("${match}"); write about the web app, not the hardware.`),
  wordCountViolation,
  ({ text }) => {
    const unterminated = unterminatedParagraphs(text)[0];
    return unterminated === undefined ? undefined : `A paragraph ends without a full stop ("...${lastWords(unterminated, 6)}"); end every sentence with punctuation.`;
  },
  patternCheck(missingSentenceBreak, (match) => `Draft runs two sentences together without a full stop ("${match}"); punctuate every sentence.`),
  patternCheck(brokenCompound, (match) => `Draft misspells a compound word ("${match}"); write "ad hoc" and the noun "trade-off".`),
  ({ text }) => (text.includes("\n\n") ? undefined : "Draft needs mobile-friendly paragraph spacing."),
  ({ text }) => (text.endsWith("?") ? undefined : "Draft must end with a genuine question."),
  patternCheck(genericQuestion, () => "Draft needs a specific closing question.", "question"),
  patternCheck(bannedQuestionOpening, () => `Closing question opens with "${bannedQuestionOpener}"; ask about a specific trade-off in a different form.`, "question"),
  ({ text }) => (text.length > maxPostLength ? `Draft exceeds LinkedIn's ${maxPostLength}-character limit.` : undefined),
  ({ hook, question, context }) => varietyViolations(hook, question, context.recentPosts ?? []),
  ({ draft, context, themes }) => themeViolations(draft.theme, context.recentThemes ?? [], Object.keys(themes).length),
  ({ text }) => {
    const spelled = spelledNumbers(text);
    return spelled.length
      ? `Draft spells out figures in words (${spelled.join(", ")}); write numbers as digits so they can be checked against the evidence.`
      : undefined;
  },
  ({ text, context }) => {
    const invented = context.evidence ? unsupportedNumbers(text, context.evidence) : [];
    return invented.length ? `Draft contains numbers absent from the evidence (${invented.join(", ")}); use only figures the sources state.` : undefined;
  },
  ({ draft, now, limits, evidence }) => sourceViolations(draft.sources, now, limits.sourceWindowDays, evidence),
];

// Every rule is checked and every violation reported, so the one corrective attempt the
// model gets can fix all of them at once instead of discovering them one per draft.
export function draftViolations(
  draft: Draft,
  now = new Date(),
  context: DraftContext = {},
  { limits, persona, themes, evidence }: RuleSettings = config(),
) {
  const text = draft.text.trim();
  const parts: DraftParts = { draft, text, hook: firstParagraph(text), question: lastParagraph(text), now, context, limits, persona, themes, evidence };
  return checks.flatMap((check) => check(parts) ?? []);
}

// The bare range was not enough: a corrected draft came back at 133 words against a
// floor of 140. The model is told how far to move and toward the middle, not the edge.
function wordCountViolation({ text, limits }: DraftParts) {
  const words = text.split(/\s+/).length;
  if (words >= limits.minWords && words <= limits.maxWords) return undefined;
  const target = wordTarget(limits);
  const fix = words < limits.minWords
    ? `Add about ${target - words} words, for example one more concrete sentence in the context or insight paragraph.`
    : `Cut about ${words - target} words.`;
  return `Draft must contain ${limits.minWords} to ${limits.maxWords} words; received ${words}. ${fix}`;
}

// Banning phrases one at a time never holds: the model finds the next groove. Comparing
// the opener and closer against what actually went out is what forces variety.
function varietyViolations(hook: string, closingQuestion: string, recentPosts: string[]) {
  if (!recentPosts.length) return [];
  const violations: string[] = [];
  const recentHooks = recentPosts.map((post) => firstParagraph(post));
  const previousHook = recentHooks.at(-1) ?? "";
  if (openingWords(hook, 1) === openingWords(previousHook, 1)) {
    violations.push(`Hook starts with the same word as the previous post ("${openingWords(previousHook, 1)}"); open a different way.`);
  }
  if (recentHooks.some((recent) => openingWords(recent, 3) === openingWords(hook, 3))) {
    violations.push(`Hook opens with the same words as a recent post ("${openingWords(hook, 3)}"); vary the opener.`);
  }
  const recentQuestions = recentPosts.map((post) => lastParagraph(post));
  if (recentQuestions.some((recent) => openingWords(recent, 3) === openingWords(closingQuestion, 3))) {
    violations.push(`Closing question opens like a recent post ("${openingWords(closingQuestion, 3)}"); ask it in a different form.`);
  }
  return violations;
}

// With a single theme configured there is nothing to rotate to, and the rule would
// reject every draft once a post exists.
function themeViolations(theme: string | undefined, recentThemes: string[], themeCount: number) {
  const previous = recentThemes.at(-1);
  if (themeCount > 1 && theme && previous && theme === previous) {
    return [`Draft repeats the previous post's theme (${theme}); the run must not publish the same theme twice in a row.`];
  }
  return [];
}

export function wordTarget(limits: Pick<Config["limits"], "minWords" | "maxWords">) {
  return Math.round((limits.minWords + limits.maxWords) / 2);
}

function unterminatedParagraphs(text: string) {
  const paragraphs = text.trim().split(/\n{2,}/).map((paragraph) => paragraph.trim());
  return paragraphs.slice(1, -1)
    .filter((paragraph) => paragraph && !paragraph.includes("\n") && !terminalPunctuation.test(paragraph));
}

function lastWords(text: string, count: number) {
  return text.split(/\s+/).slice(-count).join(" ");
}

// Judged by calendar day, so a source from the first day of the window is not rejected
// merely because the run started late in the evening.
function sourceViolations(sources: ResearchSource[], now: Date, windowDays: number, evidence: DraftSettings["evidence"]) {
  if (!sources.length || !meetsEvidenceBar(sources.map((source) => source.url), evidence)) {
    return ["Draft needs one first-party source or two credible sources from different publishers, at least one of them not GitHub, Hugging Face or arXiv."];
  }
  const violations: string[] = [];
  const { oldest: oldestDay, latest: latestDay } = recentDays(now, windowDays);
  for (const source of sources) {
    const day = source.publishedDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < oldestDay || day > latestDay) {
      violations.push(`Source is not verifiably recent: ${source.title}.`);
    }
    if (!URL.canParse(source.url)) violations.push(`Source URL is invalid: ${source.title}.`);
  }
  return violations;
}
