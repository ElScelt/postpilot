import { config, type Config } from "../config";
import { meetsEvidenceBar } from "../research/sources";
import { recentDays } from "../scheduling/time";
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
const experienceClaim = new RegExp(
  `\\b(?:i|we)\\b(?:'ve|\\s+have)?\\s+(?:just\\s+|already\\s+|finally\\s+)?(?:been\\s+\\w+ing|${experienceVerbs.join("|")})\\b`, "i",
);

// The hook rule above guards the opening line; the body needs the same guard, because
// "Our codebase was on Next.js 14, so the upgrade became mandatory" is invented history
// wherever it appears. Decisions are stated in the present or the conditional.
const fabricatedHistory = new RegExp(
  `\\b(?:our|my)\\s+(?:codebase|code\\s?base|app|apps|application|project|projects|stack|team|pipeline|service|services|product|repo|repository|monorepo)\\s+(?:was|were|had|has\\s+been|have\\s+been|used\\s+to|ran|runs\\s+on|is\\s+on|are\\s+on|sits\\s+on)\\b` +
  `|\\b(?:i|we)\\b(?:'ve|\\s+have)?\\s+(?:just\\s+|already\\s+|finally\\s+|recently\\s+)?(?:been\\s+\\w+ing|${experienceVerbs.join("|")})\\b`, "i",
);

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
  const history = text.match(fabricatedHistory);
  if (history) {
    violations.push(`Draft states invented history ("${history[0]}"); say what you would do or verify instead of what was done.`);
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
    violations.push(`Draft must contain ${limits.minWords} to ${limits.maxWords} words; received ${words}.`);
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
  if (text.length > 3000) violations.push("Draft exceeds LinkedIn's configured text limit.");
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

// A number is a run of digits not glued to letters (p95, ES2015, S3 are names) and not
// part of a fraction like 24/7. Numbers under ten without a decimal are counts ("three
// checks", "2 sources") and never the problem; the recycled 70 tok/s threshold is.
// A K, M or B suffix stays part of the figure ("10M-token grant"), so it is checked like
// any other number instead of escaping as a word.
const numberToken = /(?<![A-Za-z\d./])\d+(?:[.,]\d+)*(?:[kKmMbB](?![A-Za-z]))?(?![A-Za-z\d/])/g;

export function unsupportedNumbers(text: string, evidence: string[]) {
  const known = new Set<string>();
  const normalise = (value: string) => value.replace(/,/g, "").toUpperCase();
  for (const match of evidence.join("\n").matchAll(numberToken)) {
    const value = normalise(match[0]);
    known.add(value);
    // "16.3" in the evidence also supports "16"; "16.3.0" also supports "16.3".
    const parts = value.split(".");
    for (let length = 1; length <= parts.length; length += 1) known.add(parts.slice(0, length).join("."));
  }
  // A suffixed figure ("2B parameters") is large by definition, whatever its digits say.
  const found = [...text.matchAll(numberToken)]
    .map((match) => match[0].replace(/,/g, ""))
    .filter((value) => value.includes(".") || /[kKmMbB]$/.test(value) || Number(value) >= 10);
  // A patch version the evidence states as a minor ("16.3.0" against "16.3") is supported.
  const supported = (raw: string) => {
    const value = normalise(raw);
    const parts = value.split(".");
    return parts.some((_, index) => index > 0 && known.has(parts.slice(0, parts.length - index).join("."))) || known.has(value);
  };
  return [...new Set(found)].filter((value) => !supported(value));
}

// The digit check above taught the model to write "ten ms" and "a three-hundred second
// timeout", which reads as exactly the dodge it is. Any figure of ten or more written in
// words is rejected outright, so figures arrive as digits and the evidence check applies.
const smallNumberWords: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const scaleWords: Record<string, number> = { hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 };
const numberWord = [...Object.keys(smallNumberWords), ...Object.keys(scaleWords)].join("|");
const spelledNumber = new RegExp(`\\b(?:${numberWord})(?:[ -](?:and[ -])?(?:${numberWord}))*\\b`, "gi");

export function spelledNumbers(text: string) {
  const found: string[] = [];
  for (const match of text.matchAll(spelledNumber)) {
    const words = match[0].toLowerCase().split(/[ -]+/).filter((word) => word !== "and");
    // "$4 per million" and "a hundred" are units of measure, not figures; "two thousand" is a figure.
    if (words.length === 1 && words[0]! in scaleWords) continue;
    let total = 0;
    let current = 0;
    for (const word of words) {
      const small = smallNumberWords[word];
      if (small !== undefined) current += small;
      else if (word === "hundred") current = (current || 1) * 100;
      else {
        total += (current || 1) * (scaleWords[word] ?? 1);
        current = 0;
      }
    }
    if (total + current >= 10) found.push(match[0]);
  }
  return [...new Set(found)];
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
