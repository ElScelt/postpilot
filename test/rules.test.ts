import test from "node:test";
import assert from "node:assert/strict";
import { draftViolations } from "../src/lib/drafting/rules";
import { spelledNumbers, unsupportedNumbers } from "../src/lib/drafting/numbers";
import { config } from "../src/lib/config";

function validateDraft(...args: Parameters<typeof draftViolations>) {
  const violations = draftViolations(...args);
  if (violations.length) throw new Error(violations.join(" "));
}

const source = {
  title: "A primary-source announcement",
  url: "https://openai.com/index/announcement",
  publishedDate: "2026-07-10",
  primary: true,
};

const unrated = {
  title: "An aggregator round-up",
  url: "https://aimultiple.com/ai-agent-tools",
  publishedDate: "2026-07-10",
  primary: false,
};

const now = new Date("2026-07-14");
const hook = "Streaming the first token early matters more than raw speed.";
const filler = "Agent reliability depends on permissions, observable tool use, and controlled execution boundaries. ";
const body = `${filler.repeat(6)}\n\n${filler.repeat(5)}`;
const question = "Where does your production workflow need a stronger boundary?";
const draft = (text: string, overrides = {}) => ({ text, topic: "Agents", sources: [source], ...overrides });

test("rejects stale-news language even when the draft is otherwise valid", () => {
  const text = `OpenAI just launched a useful agent capability.\n\n${body}\n\nWhat would you test first?`;
  assert.throws(() => validateDraft(draft(text), now), /freshness claim \("just"\)/i);
});

test("rejects vague freshness language that does not name a date", () => {
  const text = `A tool was recently announced with a useful developer capability.\n\n${body}\n\nWhich workflow would you change first?`;
  assert.throws(() => validateDraft(draft(text), now), /freshness claim \("recently"\)/i);
});

test("rejects em-dashes, the loudest generated-text tell in the author's feed", () => {
  const text = `${hook}\n\nThe economics improve — dramatically so — for batched requests.\n\n${body}\n\n${question}`;
  assert.throws(() => validateDraft(draft(text), now), /em-dash/i);
});

test("rejects citation placeholders left in the paragraph text", () => {
  const text = `${hook}\n\nThe harness instruments model turns automatically (source).\n\n${body}\n\n${question}`;
  assert.throws(() => validateDraft(draft(text), now), /citation placeholder \("\(source\)"\)/i);
});

test("rejects links and e-mail addresses in the body", () => {
  const text = `${hook}\n\nSign up at https://evil.example/free-trial today or write to promo@evil.example.\n\n${body}\n\n${question}`;
  assert.throws(() => validateDraft(draft(text), now), /link or e-mail address \("https:\/\/"\)/i);
  const packages = `${hook}\n\nThe @tanstack/react-query and @prisma/client upgrades are the #1 cost driver here.\n\n${body}\n\n${question}`;
  assert.doesNotThrow(() => validateDraft(draft(packages), now));
});

test("rejects a hook a phone would cut before see more", () => {
  const longHook = "Streaming the first token early matters more than raw speed when the route handler is doing the buffering and the component is waiting on the whole response anyway.";
  assert.throws(() => validateDraft(draft(`${longHook}\n\n${body}\n\n${question}`), now), /Hook is \d+ characters/);
});

test("rejects a generic closing question", () => {
  const text = `${hook}\n\n${body}\n\n${filler.repeat(2)}\n\nWhat do you think?`;
  assert.throws(() => validateDraft(draft(text), now), /closing question/i);
});

test("rejects a hook that invents personal testing the evidence cannot support", () => {
  const text = `I stopped trusting AI code suggestions until they survived a sabotage-benchmark test.\n\n${body}\n\n${question}`;
  assert.throws(() => validateDraft(draft(text), now), /personal testing or usage the evidence cannot support \("I stopped"\)/i);
});

test("rejects a hook that claims a usage history", () => {
  const text = `I have been running a provider-agnostic SDK across two production services.\n\n${body}\n\n${question}`;
  assert.throws(() => validateDraft(draft(text), now), /personal testing or usage/i);
});

test("accepts a hook that states a decision rather than an experience", () => {
  const text = `I am standardizing on a provider-agnostic SDK, and I would test failover before trusting it.\n\n${body}\n\n${question}`;
  assert.doesNotThrow(() => validateDraft(draft(text), now));
});

test("rejects a draft padded with two unrated aggregators", () => {
  assert.throws(
    () => validateDraft(draft(`${hook}\n\n${body}\n\n${question}`, { sources: [unrated, { ...unrated, url: "https://tech-insider.org/gemini" }] }), now),
    /first-party source or two credible sources/i,
  );
});

test("ignores a primary flag that the source URL does not support", () => {
  assert.throws(
    () => validateDraft(draft(`${hook}\n\n${body}\n\n${question}`, { sources: [{ ...unrated, primary: true }] }), now),
    /first-party source or two credible sources/i,
  );
});

test("accepts a sourced, readable post within the target length", () => {
  assert.doesNotThrow(() => validateDraft(draft(`${hook}\n\n${body}\n\n${question}`), now));
});

test("a draft over LinkedIn's length limit is rejected with the limit named", () => {
  const long = `${hook}

${filler.repeat(40)}

${question}`;
  assert.match(draftViolations(draft(long), now).join(" "), /exceeds LinkedIn's 3000-character limit/);
});

test("reports every violation at once so one correction can fix them all", () => {
  const text = `I tested this and it is just faster — really.\n\n${body}\n\n${question}`;
  const violations = draftViolations(draft(text, { sources: [] }), now);
  assert.match(violations.join(" "), /freshness claim/);
  assert.match(violations.join(" "), /personal testing/);
  assert.match(violations.join(" "), /em-dash/);
  assert.match(violations.join(" "), /first-party source/);
});

test("accepts a source from the first day of the search window", () => {
  const evening = new Date("2026-09-03T18:00:00.000Z");
  const boundary = { ...source, publishedDate: "2026-08-20" };
  assert.doesNotThrow(() => validateDraft(draft(`${hook}\n\n${body}\n\n${question}`, { sources: [boundary] }), evening));
  const stale = { ...source, publishedDate: "2026-08-19" };
  assert.throws(() => validateDraft(draft(`${hook}\n\n${body}\n\n${question}`, { sources: [stale] }), evening), /not verifiably recent/);
});

const evidence = ["A vendor cut the price to $4 per million input tokens, down from $5, on 2026-07-10."];

test("rejects the banned closing question even when the prompt was ignored", () => {
  const text = `${hook}\n\n${body}\n\nHow do you balance throughput against cost?`;
  assert.throws(() => validateDraft(draft(text, { topic: "Streaming" }), now), /How do you balance/);
});

test("rejects a paragraph that opens by announcing the configured stack", () => {
  const text = `${hook}\n\nFor a TypeScript backend that streams to React, this changes the route handler.\n\n${body}\n\nWhere would you cut the first render?`;
  const withStack = { ...config(), persona: { ...config().persona, stack: ["TypeScript", "Node.js", "React"] } };
  assert.throws(() => validateDraft(draft(text), now, {}, withStack), /announces the stack/);
  assert.doesNotThrow(() => validateDraft(draft(text), now), "without a configured stack only the perspective opener is checked");
  const perspective = `${hook}\n\nFrom a backend perspective, this changes the route handler.\n\n${body}\n\nWhere would you cut the first render?`;
  assert.throws(() => validateDraft(draft(perspective), now), /announces the stack/);
});

test("rejects an infrastructure decision outside the author's scale", () => {
  const text = `${hook}\n\n${body}\n\nThe model sustains 70 tokens/sec on a GPU cluster, so I would run it in a Kubernetes pod.\n\nWhere would you cut the first render?`;
  assert.throws(() => validateDraft(draft(text), now), /outside the author's scale \("tokens\/sec"\)/);
});

test("rejects an academic inline citation in any date order", () => {
  for (const citation of ["(NVIDIA, Aug 24 2026)", "(Vercel, 24 Aug 2026)", "(Vercel, August 2026)"]) {
    const text = `${hook}\n\nThe vendor extends the platform ${citation}.\n\n${body}\n\nWhere would you cut the first render?`;
    assert.throws(() => validateDraft(draft(text), now), /academic citation/, citation);
  }
});

test("rejects a hook that opens like a recent post", () => {
  const recent = `I'm standardizing on server actions for every mutation.\n\n${body}\n\nWhich mutation would you move first?`;
  const later = `Server actions are the wrong default for every mutation.\n\n${body}\n\nWhere does your form logic live?`;
  const text = `I'm standardizing on streamed responses for every chat surface.\n\n${body}\n\nWhere would you cut the first render?`;
  assert.throws(
    () => validateDraft(draft(text), now, { recentPosts: [recent, later] }),
    /same words as a recent post/,
  );
});

test("rejects a hook that starts with the previous post's first word", () => {
  const recent = `I'm standardizing on server actions for every mutation.\n\n${body}\n\nWhich mutation would you move first?`;
  const text = `I’m going to stream every chat response from the route handler.\n\n${body}\n\nWhere would you cut the first render?`;
  assert.throws(
    () => validateDraft(draft(text), now, { recentPosts: [recent] }),
    /same word as the previous post/,
  );
});

test("rejects a closing question that opens like a recent one", () => {
  const recent = `Server actions are the wrong default for every mutation.\n\n${body}\n\nWhich mutation would you move first?`;
  const text = `${hook}\n\n${body}\n\nWhich mutation would you stream first?`;
  assert.throws(
    () => validateDraft(draft(text), now, { recentPosts: [recent] }),
    /opens like a recent post/,
  );
});

test("accepts a hook and question that differ from every recent post", () => {
  const recent = `I'm standardizing on server actions for every mutation.\n\n${body}\n\nWhich mutation would you move first?`;
  const text = `${hook}\n\n${body}\n\nWhere would you cut the first render?`;
  assert.doesNotThrow(() => validateDraft(draft(text), now, { recentPosts: [recent] }));
});

test("rejects the same theme two posts in a row", () => {
  const text = `${hook}\n\n${body}\n\nWhere would you cut the first render?`;
  assert.throws(
    () => validateDraft(draft(text, { theme: "frontend" }), now, { recentThemes: ["data", "frontend"] }),
    /repeats the previous post's theme/,
  );
  assert.doesNotThrow(() => validateDraft(draft(text, { theme: "frontend" }), now, { recentThemes: ["frontend", "data"] }));
});

test("rejects numbers the evidence does not state", () => {
  const text = `Input tokens now cost $4 per million, down from $5.\n\n${body}\n\nI would hold any model to at least 45 tokens per request before switching.\n\nWhere would you cut the first render?`;
  assert.throws(
    () => validateDraft(draft(text, { topic: "Pricing" }), now, { evidence }),
    /numbers absent from the evidence \(45\)/,
  );
});

test("accepts numbers the evidence states and ignores small counts", () => {
  const text = `Input tokens now cost $4 per million, down from $5.\n\n${body}\n\nI would check 3 things before switching, starting on 2026-07-10.\n\nWhere would you cut the first render?`;
  assert.doesNotThrow(() => validateDraft(draft(text, { topic: "Pricing" }), now, { evidence }));
});

test("lists every unsupported number once", () => {
  assert.deepEqual(unsupportedNumbers("70 tok/s and 42.4 tok/s and 70 again, 1,000 users, 3 steps", ["1000 users"]), ["70", "42.4"]);
});

test("a number hidden inside a date no longer counts as evidence", () => {
  assert.deepEqual(unsupportedNumbers("20% of users saw 26 endpoints", ["published 2026-09-01"]), ["20", "26"]);
});

test("version strings, protocol names and fractions are not invented figures", () => {
  assert.deepEqual(
    unsupportedNumbers("OAuth 2.0 with TLS 1.3, p95 latency, 24/7 uptime, ES2015 targets, version 16.3.0 and Next 16", ["Next.js 16.3 ships TLS 1.3 and OAuth 2.0"]),
    [],
  );
});

test("figures spelled out in words are rejected so they arrive as digits", () => {
  assert.deepEqual(
    spelledNumbers("ten ms of CPU, a three-hundred second timeout, a thirty-minute limit, a five-minute window, two thousand users, twenty five calls, one developer, hundreds of calls, $4 per million tokens, a hundred users, ElevenLabs"),
    ["ten", "three-hundred", "thirty", "two thousand", "twenty five"],
  );
  const text = `Edge functions with five-minute limits beat servers for small helpers.\n\n${body}\n\nWorkers give ten ms of CPU on the free plan.\n\nWhere would you cut the first render?`;
  assert.throws(() => validateDraft(draft(text, { topic: "Edge" }), now, { evidence }), /spells out figures in words \(ten\)/);
});

test("markup LinkedIn would show literally is rejected", () => {
  const text = `Upgrading the test runner first keeps the pipeline honest.\n\n${body}\n\n* Upgrade first. * Then run the suite.\n\nWhere would you cut the first render?`;
  assert.throws(() => validateDraft(draft(text, { topic: "Runner" }), now), /markup LinkedIn shows literally \("\*"\)/);
  const bold = `Upgrading the test runner first keeps the pipeline honest.\n\n${body}\n\nRun the **whole** suite in \`CI\`.\n\nWhere would you cut the first render?`;
  assert.throws(() => validateDraft(draft(bold, { topic: "Runner" }), now), /markup LinkedIn shows literally/);
});

test("invented history anywhere in the body is rejected", () => {
  for (const sentence of ["Our codebase was on Next.js 14, so the upgrade became mandatory.", "We migrated the suite last sprint.", "I ran the benchmark twice."]) {
    const text = `Upgrading the test runner first keeps the pipeline honest.\n\n${body}\n\n${sentence}\n\nWhere would you cut the first render?`;
    assert.throws(() => validateDraft(draft(text, { topic: "Runner" }), now), /invented history/, sentence);
  }
  const fine = `Upgrading the test runner first keeps the pipeline honest.\n\n${body}\n\nI would run the suite twice before trusting the result.\n\nWhere would you cut the first render?`;
  assert.doesNotThrow(() => validateDraft(draft(fine, { topic: "Runner" }), now));
});

test("talk about the research itself is rejected", () => {
  for (const sentence of ["Both sources were published in late August 2026.", "The evidence shows a clear trend.", "These sources agree on the price."]) {
    const text = `Upgrading the test runner first keeps the pipeline honest.\n\n${body}\n\n${sentence}\n\nWhere would you cut the first render?`;
    assert.throws(() => validateDraft(draft(text, { topic: "Runner" }), now), /talks about its research/, sentence);
  }
  const fine = `Upgrading the test runner first keeps the pipeline honest.\n\n${body}\n\nA single source of truth for config beats three copies.\n\nWhere would you cut the first render?`;
  assert.doesNotThrow(() => validateDraft(draft(fine, { topic: "Runner" }), now));
});

test("a figure with a K, M or B suffix is checked like any other number", () => {
  assert.deepEqual(unsupportedNumbers("a 10M-token grant, 2B parameters and 50k users", ["a 10M token grant for 50K users"]), ["2B"]);
});

// From a queued post on the first live test, with every full stop missing.
test("a paragraph without a closing full stop and run-on sentences are rejected", () => {
  const unterminated = `${hook}\n\n${body}\n\nIt also makes error handling deterministic\n\n${question}`;
  assert.throws(() => validateDraft(draft(unterminated), now), /paragraph ends without a full stop \("\.\.\.It also makes error handling deterministic"\)/);
  const runOn = `${hook}\n\n${body} Forbes covered Structured Outputs announced in August 2024 The same source notes a limit.\n\n${question}`;
  assert.throws(() => validateDraft(draft(runOn), now), /runs two sentences together without a full stop \("2024 The"\)/);
  const checklist = `${hook}\n\n${body}\n\nVerify the version is at least 15.5\nAdd an integration test\n\n${question}`;
  assert.doesNotThrow(() => validateDraft(draft(checklist), now), "checklist lines may end without a full stop");
  const title = `${hook}\n\n${body} Forbes ran Why Everyone Is Talking About The AI That Does Not Chat.\n\n${question}`;
  assert.doesNotThrow(() => validateDraft(draft(title), now), "a title-cased phrase is not a run-on");
});

test("run-together compounds are rejected", () => {
  for (const sentence of ["It removes adhoc string parsing.", "The trade off is tighter prompts."]) {
    const text = `${hook}\n\n${body}\n\n${sentence}\n\n${question}`;
    assert.throws(() => validateDraft(draft(text), now), /misspells a compound word/, sentence);
  }
  const verb = `${hook}\n\n${body}\n\nYou trade off latency for accuracy.\n\n${question}`;
  assert.doesNotThrow(() => validateDraft(draft(verb), now));
});

test("a present-tense claim about the author's own system is invented history", () => {
  for (const sentence of ["Our component library renders dynamic OG images from user-provided text.", "My team uses Vitest in CI.", "Our services talked to Redis."]) {
    const text = `${hook}\n\n${body}\n\n${sentence}\n\n${question}`;
    assert.throws(() => validateDraft(draft(text), now), /invented history/, sentence);
  }
  for (const sentence of ["If your component library renders OG images, upgrade first.", "Our app would need a fallback.", "I would treat our app as a client.", "Our app users expect fast pages."]) {
    const text = `${hook}\n\n${body}\n\n${sentence}\n\n${question}`;
    assert.doesNotThrow(() => validateDraft(draft(text), now), sentence);
  }
});

test("a short draft is told how many words to add", () => {
  const text = `${hook}\n\n${filler.repeat(3)}\n\n${question}`;
  const target = Math.round((config().limits.minWords + config().limits.maxWords) / 2);
  const words = text.split(/\s+/).length;
  assert.throws(() => validateDraft(draft(text), now), new RegExp(`received ${words}\. Add about ${target - words} words`));
});
