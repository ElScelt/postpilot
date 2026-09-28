// What the author cannot claim: personal tests and usage, history, and facts about their
// own systems. The model has no history to report, so every such claim is invented.

// The hook may state a decision, a position, or an intention, but never a personal test,
// measurement, or usage history the evidence cannot support. Exported so the prompt
// quotes exactly what the validator enforces.
export const experienceVerbs = [
  "ran", "tested", "benchmarked", "measured", "profiled", "tried", "used", "deployed", "shipped",
  "migrated", "rewrote", "replaced", "switched", "stopped", "started", "spent", "cut", "saved",
  "reduced", "found",
];

// "I tested", "we've just migrated", "I have been profiling".
function experiencePattern(adverbs: string[]) {
  return `\\b(?:i|we)\\b(?:'ve|\\s+have)?\\s+(?:(?:${adverbs.join("|")})\\s+)?(?:been\\s+\\w+ing|${experienceVerbs.join("|")})\\b`;
}

export const experienceClaim = new RegExp(experiencePattern(["just", "already", "finally"]), "i");

// What "our" and "my" can own: the author's codebase, product, team and the parts of them.
const systemNouns = [
  "code\\s?base", "app", "apps", "application", "applications", "project", "projects", "stack",
  "team", "pipeline", "pipelines", "service", "services", "product", "repo", "repository", "monorepo",
  "library", "libraries", "components?", "frontend", "backend", "api", "site", "website", "dashboard",
  "platform", "infrastructure", "database", "tests", "test suite", "suite", "workers?", "builds?",
].join("|");

// The hook rule above guards the opening line; the body needs the same guard, because
// "Our codebase was on Next.js 14, so the upgrade became mandatory" is invented history
// wherever it appears. Decisions are stated in the present or the conditional. "We
// recently migrated" passes in a hook, where it reads as news, but not as history.
const historyVerbs = ["was", "were", "had", "has\\s+been", "have\\s+been", "used\\s+to", "ran", "runs\\s+on", "is\\s+on", "are\\s+on", "sits\\s+on"].join("|");
const fabricatedHistory = new RegExp(
  `\\b(?:our|my)\\s+(?:${systemNouns})\\s+(?:${historyVerbs})\\b|${experiencePattern(["just", "already", "finally", "recently"])}`, "i",
);

// The same invention in the present tense: "Our component library renders dynamic OG
// images from user-provided text" went into a queued post on the first live test. A claim
// about the author's own system is framed as "if your app renders..." instead. Modals and
// "needs" state an intention or a requirement, and a noun after the system ("our app
// users") is not a verb, so both pass.
const notAVerb = [
  "as", "its", "this", "thus", "us", "plus", "across", "unless", "less", "whereas", "always", "perhaps",
  "towards", "versus", "needs", "need", "speed", "feed", "seed", "users", "customers", "teams", "pages",
  "routes", "endpoints", "components", "requests", "errors", "logs", "costs", "bills", "calls", "tests",
  "builds", "files", "types", "hooks", "props", "jobs", "queries", "tables", "models", "settings",
].join("|");
const ownSystemClaim = new RegExp(
  `\\b(?:our|my)\\s+(?:[a-z][\\w-]*\\s+){0,2}?(?:${systemNouns})\\s+` +
  `(?!(?:would|could|should|might|may|will|can|must|${notAVerb})\\b)(?:[a-z]{2,}s|[a-z]{2,}ed)\\b`, "i",
);

// Tried in this order; the first that matches is quoted back to the model.
export const inventedHistory = [fabricatedHistory, ownSystemClaim] as const;
