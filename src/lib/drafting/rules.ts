import { config, type Config } from "../config";
import { meetsEvidenceBar } from "../research/sources";
import { recentDays } from "../scheduling/time";
import { maxPostLength } from "../limits";
import { spelledNumbers, unsupportedNumbers } from "./numbers";
import type { Draft, DraftContext, ResearchSource } from "./types";

// The word lists are exported so the prompt quotes exactly what the validator enforces;
// two hand-kept copies drifted apart before.
export const freshnessWords = [
  "just", "today", "yesterday", "this week", "this month", "this year", "earlier this year",
  "recently", "latest", "brand-new", "newly", "right now",
];
const freshnessClaim = new RegExp(
  `\\b(${freshnessWords.map((word) => word.replace("-", "[- ]")).join("|")})\\b`, "i",
);

// The hook may state a decision, a position, or an intention, but never a personal test,
// measurement, or usage history the evidence cannot support.
export const experienceVerbs = [
  "ran", "tested", "benchmarked", "measured", "profiled", "tried", "used", "deployed", "shipped",
  "migrated", "rewrote", "replaced", "switched", "stopped", "started", "spent", "cut", "saved",
  "reduced", "found",
];
// "I tested", "we've just migrated", "I have been profiling".
function experiencePattern(adverbs: string[]) {
  return `\\b(?:i|we)\\b(?:'ve|\\s+have)?\\s+(?:(?:${adverbs.join("|")})\\s+)?(?:been\\s+\\w+ing|${experienceVerbs.join("|")})\\b`;
}
const experienceClaim = new RegExp(experiencePattern(["just", "already", "finally"]), "i");

// The hook rule above guards the opening line; the body needs the same guard, because
// "Our codebase was on Next.js 14, so the upgrade became mandatory" is invented history
// wherever it appears. Decisions are stated in the present or the conditional. "We
// recently migrated" passes in a hook, where it reads as news, but not as history.
const historySystems = [
  "codebase", "code\\s?base", "app", "apps", "application", "project", "projects", "stack", "team", "pipeline",
  "service", "services", "product", "repo", "repository", "monorepo",
].join("|");
const historyVerbs = ["was", "were", "had", "has\\s+been", "have\\s+been", "used\\s+to", "ran", "runs\\s+on", "is\\s+on", "are\\s+on", "sits\\s+on"].join("|");
const fabricatedHistory = new RegExp(
  `\\b(?:our|my)\\s+(?:${historySystems})\\s+(?:${historyVerbs})\\b|${experiencePattern(["just", "already", "finally", "recently"])}`, "i",
);

// The same invention in the present tense: "Our component library renders dynamic OG
// images from user-provided text" went into a queued post on the first live test. A claim
// about the author's own system is framed as "if your app renders..." instead. Modals and
// "needs" state an intention or a requirement, and a noun after the system ("our app
// users") is not a verb, so both pass.
const ownSystems = [
  "codebase", "code ?base", "app", "apps", "application", "applications", "project", "projects", "stack",
  "team", "pipeline", "pipelines", "service", "services", "product", "repo", "repository", "monorepo",
  "library", "libraries", "components?", "frontend", "backend", "api", "site", "website", "dashboard",
  "platform", "infrastructure", "database", "tests", "test suite", "suite", "workers?", "builds?",
].join("|");
const notAVerb = [
  "as", "its", "this", "thus", "us", "plus", "across", "unless", "less", "whereas", "always", "perhaps",
  "towards", "versus", "needs", "need", "speed", "feed", "seed", "users", "customers", "teams", "pages",
  "routes", "endpoints", "components", "requests", "errors", "logs", "costs", "bills", "calls", "tests",
  "builds", "files", "types", "hooks", "props", "jobs", "queries", "tables", "models", "settings",
].join("|");
const ownSystemClaim = new RegExp(
  `\\b(?:our|my)\\s+(?:[a-z][\\w-]*\\s+){0,2}?(?:${ownSystems})\\s+` +
  `(?!(?:would|could|should|might|may|will|can|must|${notAVerb})\\b)(?:[a-z]{2,}s|[a-z]{2,}ed)\\b`, "i",
);

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

type RuleSettings = Pick<Config, "limits" | "persona">;

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

// "(NVIDIA, Aug 24 2026)", "(NVIDIA, 24 Aug 2026)" and "(NVIDIA, August 2026)" are
// citation formats nobody uses on LinkedIn.
const month = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\\w*\\.?";
const academicCitation = new RegExp(
  `\\([A-Z][\\w.& -]{1,40},\\s*(?:${month}\\s+\\d{1,2},?\\s*\\d{4}|\\d{1,2}\\s+${month},?\\s*\\d{4}|${month}\\s+\\d{4})\\)`, "i",
);

const bannedQuestionOpeners = /^how do you balance\b/i;

// The prompt keeps URLs in sourceUrls, and LinkedIn linkifies anything that looks like
// one, so a link in the body is either the model ignoring the rule or an injected
// promotion. Handles and hashtags are not checked: escapeCommentary neutralises @ and #,
// and scoped package names such as @tanstack/react-query are everyday vocabulary here.
const linkOrEmail = /https?:\/\/|\bwww\.|[\w.+-]+@[\w-]+\.[a-z]{2,}/i;

// Every rule is checked and every violation reported, so the one corrective attempt the
// model gets can fix all of them at once instead of discovering them one per draft.
export function draftViolations(
  draft: Draft,
  now = new Date(),
  context: DraftContext = {},
  { limits, persona }: RuleSettings = config(),
) {
  const violations: string[] = [];
  const text = draft.text.trim();
  const freshness = text.match(freshnessClaim);
  if (freshness) violations.push(`Draft contains an unverified freshness claim ("${freshness[0]}").`);
  const hook = firstParagraph(text);
  const experience = hook.match(experienceClaim);
  if (experience) {
    violations.push(`Hook claims personal testing or usage the evidence cannot support ("${experience[0]}"); state a decision or position instead.`);
  }
  if (hook.length > limits.maxHookLength) {
    violations.push(`Hook is ${hook.length} characters; keep it under ${limits.maxHookLength} so it is not cut before "see more" on a phone.`);
  }
  if (/^topic:/im.test(text)) violations.push("Draft must not contain a Topic label.");
  // Em-dashes are the loudest generated-text tell on LinkedIn.
  if (/[—–]/.test(text)) violations.push("Draft contains an em-dash or en-dash; rewrite with commas or plain connectors.");
  const placeholder = text.match(/\((?:source|sources|link)\)|\[(?:source|sources|link|\d+)\]/i);
  if (placeholder) {
    violations.push(`Draft contains a citation placeholder ("${placeholder[0]}"); state the publisher by name or drop the reference.`);
  }
  const citation = text.match(academicCitation);
  if (citation) {
    violations.push(`Draft contains an inline academic citation ("${citation[0]}"); name the publisher inside the sentence instead.`);
  }
  const link = text.match(linkOrEmail);
  if (link) {
    violations.push(`Draft contains a link or e-mail address ("${link[0]}"); name the publisher in the sentence and keep URLs in sourceUrls.`);
  }
  const history = text.match(fabricatedHistory) ?? text.match(ownSystemClaim);
  if (history) {
    violations.push(`Draft states invented history ("${history[0]}"); say what you would do or verify, and write "if your app..." rather than describing your own system as fact.`);
  }
  const commentary = text.match(researchCommentary);
  if (commentary) {
    violations.push(`Draft talks about its research ("${commentary[0]}"); the reader sees the post, not the sources.`);
  }
  const markup = text.match(markdownMarkup);
  if (markup) {
    violations.push(`Draft contains markup LinkedIn shows literally ("${markup[0].trim() || "*"}"); write plain text with one checklist item per line and no bullet characters.`);
  }
  const costume = text.match(stackCostumePattern(persona.stack));
  if (costume) {
    violations.push(`Draft announces the stack in a paragraph opener ("${costume[0]}"); let the stack show through the decision instead.`);
  }
  const avoided = avoidedTopicPattern(persona.avoidTopics);
  const scale = avoided ? text.match(avoided) : null;
  if (scale) {
    violations.push(`Draft makes an infrastructure decision outside the author's scale ("${scale[0]}"); write about the web app, not the hardware.`);
  }
  const words = text.split(/\s+/).length;
  if (words < limits.minWords || words > limits.maxWords) {
    // The bare range was not enough: a corrected draft came back at 133 words against a
    // floor of 140. The model is told how far to move and toward the middle, not the edge.
    const target = wordTarget(limits);
    const fix = words < limits.minWords
      ? `Add about ${target - words} words, for example one more concrete sentence in the context or insight paragraph.`
      : `Cut about ${words - target} words.`;
    violations.push(`Draft must contain ${limits.minWords} to ${limits.maxWords} words; received ${words}. ${fix}`);
  }
  const unterminated = unterminatedParagraphs(text);
  if (unterminated.length) {
    violations.push(`A paragraph ends without a full stop ("...${lastWords(unterminated[0]!, 6)}"); end every sentence with punctuation.`);
  }
  const runOn = text.match(missingSentenceBreak);
  if (runOn) {
    violations.push(`Draft runs two sentences together without a full stop ("${runOn[0]}"); punctuate every sentence.`);
  }
  const compound = text.match(brokenCompound);
  if (compound) {
    violations.push(`Draft misspells a compound word ("${compound[0]}"); write "ad hoc" and the noun "trade-off".`);
  }
  if (!text.includes("\n\n")) violations.push("Draft needs mobile-friendly paragraph spacing.");
  if (!text.endsWith("?")) violations.push("Draft must end with a genuine question.");
  const closingQuestion = lastParagraph(text);
  if (/^(what do you think|thoughts|any thoughts|agree)\?$/i.test(closingQuestion)) {
    violations.push("Draft needs a specific closing question.");
  }
  if (bannedQuestionOpeners.test(closingQuestion)) {
    violations.push('Closing question opens with "How do you balance"; ask about a specific trade-off in a different form.');
  }
  if (text.length > maxPostLength) violations.push(`Draft exceeds LinkedIn's ${maxPostLength}-character limit.`);
  violations.push(...varietyViolations(hook, closingQuestion, context.recentPosts ?? []));
  violations.push(...themeViolations(draft.theme, context.recentThemes ?? []));
  const spelled = spelledNumbers(text);
  if (spelled.length) {
    violations.push(`Draft spells out figures in words (${spelled.join(", ")}); write numbers as digits so they can be checked against the evidence.`);
  }
  if (context.evidence) {
    const invented = unsupportedNumbers(text, context.evidence);
    if (invented.length) {
      violations.push(`Draft contains numbers absent from the evidence (${invented.join(", ")}); use only figures the sources state.`);
    }
  }
  violations.push(...sourceViolations(draft.sources, now, limits.sourceWindowDays));
  return violations;
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

function themeViolations(theme: string | undefined, recentThemes: string[]) {
  const previous = recentThemes.at(-1);
  if (theme && previous && theme === previous) {
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

export function firstParagraph(text: string) {
  return text.trim().split(/\n{2,}/)[0]?.trim() ?? "";
}

export function lastParagraph(text: string) {
  return text.trim().split(/\n{2,}/).at(-1)?.trim() ?? "";
}

export function openingWords(text: string, count: number) {
  return text.toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9'\s]/g, " ")
    .trim().split(/\s+/).slice(0, count).join(" ");
}

// Judged by calendar day, so a source from the first day of the window is not rejected
// merely because the run started late in the evening.
function sourceViolations(sources: ResearchSource[], now: Date, windowDays: number) {
  if (!sources.length || !meetsEvidenceBar(sources.map((source) => source.url))) {
    return ["Draft needs one first-party source or two credible sources from different publishers."];
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
