import test from "node:test";
import assert from "node:assert/strict";
import { DraftRejectedError, generateGroundedDraft } from "../src/lib/drafting/pipeline";
import { GroqRequestTooLargeError } from "../src/lib/drafting/groq";
import { themeIds, themeDefinition, themeOrder, type PostTheme } from "../src/lib/research/themes";

process.env.GROQ_API_KEY = "test-key";
process.env.TAVILY_API_KEY = "test-key";
delete process.env.GROQ_MODEL;

const now = new Date("2026-09-06T18:00:00.000Z");
const noRecent = { posts: [], topics: [], sourceUrls: [], themes: [] };
const firstTheme = themeOrder([], now)[0]!;
const secondTheme = themeOrder([], now)[1]!;

const hook = "Streaming the first token early matters more than raw speed.";
const filler = "Agent reliability depends on permissions, observable tool use, and controlled execution boundaries. ";
const question = "Where does your production workflow need a stronger boundary?";
const primary = { title: "Next.js 16.3", url: "https://nextjs.org/blog/next-16-3", content: "Release details with no figures.", published_date: "2026-09-04T09:00:00Z" };
const listicle = { title: "Top tools", url: "https://aimultiple.com/tools", content: "A round-up.", published_date: "2026-09-04T09:00:00Z" };

function decisionJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    shouldPost: true, reason: "fresh", topic: "Streaming UI", theme: firstTheme,
    paragraphs: { hook, context: filler.repeat(6), insight: filler.repeat(5), takeaway: "One rule: stream early.", question },
    sourceUrls: [primary.url],
    ...overrides,
  });
}

function groqPayload(content: string, finishReason = "stop") {
  return Response.json({ choices: [{ message: { content }, finish_reason: finishReason }] });
}

// Routes Tavily calls to a per-theme result list and Groq calls to a queue of answers.
function fakeFetch(tavily: (theme: PostTheme) => unknown[], groqAnswers: string[]) {
  const groqBodies: string[] = [];
  const groqRequests: Array<{ reasoning_effort: string; max_completion_tokens: number }> = [];
  const reviewBodies: string[] = [];
  const reviewRequests: Array<{ reasoning_effort: string; max_completion_tokens: number }> = [];
  const themesSearched: PostTheme[] = [];
  const answerWith = (answer: string) => {
    if (answer === "__413__") return new Response("Request too large for model", { status: 413 });
    // "__400json__" is an empty refusal; "__400json__:<text>" carries the failed generation.
    if (answer.startsWith("__400json__")) {
      const generation = answer.slice("__400json__".length).replace(/^:/, "");
      return new Response(JSON.stringify({ error: { message: "Failed to validate JSON.", type: "invalid_request_error", code: "json_validate_failed", failed_generation: generation } }), { status: 400 });
    }
    return groqPayload(answer);
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    if (url.includes("tavily")) {
      const searched = themeIds().find((candidate) => themeDefinition(candidate).queries.includes(body.query))!;
      if (!themesSearched.includes(searched)) themesSearched.push(searched);
      return Response.json({ results: tavily(searched) });
    }
    const content: string = body.messages[0].content;
    // A review request is answered from the queue only when the next answer is marked
    // for it; otherwise the draft embedded in the prompt is echoed back unchanged.
    if (content.startsWith("Review a LinkedIn post")) {
      reviewBodies.push(content);
      reviewRequests.push(body);
      const marked = groqAnswers[0]?.startsWith("__review__:") ? groqAnswers.shift()!.slice("__review__:".length) : undefined;
      return answerWith(marked ?? content.match(/<draft>\n([\s\S]*)\n<\/draft>/)![1]!);
    }
    groqBodies.push(content);
    groqRequests.push(body);
    const answer = groqAnswers.shift();
    if (answer === undefined) throw new Error("Groq called more often than expected");
    return answerWith(answer);
  };
  return { fetcher, groqBodies, groqRequests, reviewBodies, reviewRequests, themesSearched };
}

test("feeds every validation failure back and accepts the corrected second draft", async () => {
  const withDash = decisionJson({ paragraphs: { hook: `${hook} — really`, context: filler.repeat(6), insight: filler.repeat(5), takeaway: "Rule.", question } });
  const { fetcher, groqBodies } = fakeFetch(() => [primary], [withDash, decisionJson()]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(groqBodies.length, 2);
  assert.match(groqBodies[1]!, /previous draft failed validation: Draft contains an em-dash/);
  assert.match(groqBodies[1]!, /<draft>\n.*really/s);
  assert.equal(outcome.decision.shouldPost, true);
  assert.equal(outcome.theme, firstTheme);
  assert.equal(outcome.attempts.length, 1);
});

test("gives up after the second invalid draft and keeps both attempts", async () => {
  const withDash = decisionJson({ paragraphs: { hook: `${hook} — really`, context: filler.repeat(6), insight: filler.repeat(5), takeaway: "Rule.", question } });
  const { fetcher } = fakeFetch(() => [primary], [withDash, withDash]);
  await assert.rejects(
    () => generateGroundedDraft(noRecent, now, fetcher, { maxThemesDrafted: 1 }),
    (error: unknown) => error instanceof DraftRejectedError && error.attempts.length === 2 && error.theme === firstTheme,
  );
});

test("a malformed answer gets the same correction as an invalid one", async () => {
  const { fetcher, groqBodies } = fakeFetch(() => [primary], ["not json at all", decisionJson()]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(outcome.decision.shouldPost, true);
  assert.equal(groqBodies.length, 2);
  assert.match(groqBodies[1]!, /previous draft failed validation/);
  assert.equal(outcome.attempts[0]!.text, "not json at all");
});

test("a source URL the evidence does not contain is corrected, not fatal", async () => {
  const { fetcher, groqBodies } = fakeFetch(() => [primary], [decisionJson({ sourceUrls: ["https://nextjs.org/blog/other"] }), decisionJson()]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(outcome.decision.shouldPost, true);
  assert.match(groqBodies[1]!, /Source URL was not present in the evidence/);
});

test("moves on to the next theme when the first theme's evidence cannot clear the bar", async () => {
  const { fetcher, groqBodies, themesSearched } = fakeFetch(
    (theme) => (theme === firstTheme ? [listicle] : [primary]),
    [decisionJson({ theme: secondTheme })],
  );
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.deepEqual(themesSearched, [firstTheme, secondTheme]);
  assert.deepEqual(outcome.themesTried, [firstTheme, secondTheme]);
  assert.equal(outcome.theme, secondTheme);
  assert.deepEqual(outcome.evidenceHosts[firstTheme], ["aimultiple.com"]);
  assert.match(groqBodies[0]!, new RegExp(`Report "${secondTheme}" in the theme field`));
});

test("skips the night with the themes tried when no theme has usable evidence", async () => {
  const { fetcher, groqBodies } = fakeFetch(() => [], []);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(outcome.decision.shouldPost, false);
  assert.match(outcome.decision.reason, /No dated recent evidence found \(tried /);
  assert.equal(outcome.themesTried.length, themeIds().length);
  assert.equal(groqBodies.length, 0);
});

test("reports weak evidence when every theme returns only unrated sources", async () => {
  const { fetcher } = fakeFetch(() => [listicle], []);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(outcome.decision.shouldPost, false);
  assert.match(outcome.decision.reason, /lacks a first-party source or two credible publishers/);
});

test("the theme actually researched wins over the theme the model reports", async () => {
  const other = themeIds().find((theme) => theme !== firstTheme)!;
  const { fetcher } = fakeFetch(() => [primary], [decisionJson({ theme: other })]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.ok(outcome.decision.shouldPost);
  assert.equal(outcome.decision.theme, firstTheme);
});

const decline = (theme: PostTheme, reason = "Only a rehash is possible.") =>
  decisionJson({ shouldPost: false, reason, topic: "", theme, paragraphs: { hook: "", context: "", insight: "", takeaway: "", question: "" }, sourceUrls: [] });

test("a theme the model declines is followed by the next theme with evidence", async () => {
  const { fetcher, groqBodies } = fakeFetch(() => [primary], [decline(firstTheme), decisionJson({ theme: secondTheme })]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(outcome.decision.shouldPost, true);
  assert.equal(outcome.theme, secondTheme);
  assert.deepEqual(outcome.themesTried, [firstTheme, secondTheme]);
  assert.equal(groqBodies.length, 2);
  assert.equal(outcome.attempts.length, 0, "a decline is not a rejected draft");
});

test("when every drafted theme declines, the night is skipped with each theme's reason", async () => {
  const themes = themeOrder([], now);
  const { fetcher, groqBodies } = fakeFetch(() => [primary], themes.map((theme) => decline(theme, `${theme} is stale`)));
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(outcome.decision.shouldPost, false);
  assert.match(outcome.decision.reason, new RegExp(`No theme had a story worth posting \\(${themes[0]}: ${themes[0]} is stale; ${themes[1]}: .*; ${themes[2]}: .*\\)`));
  assert.equal(groqBodies.length, 3, "three themes a night, not six");
  assert.deepEqual(outcome.themesTried, themes.slice(0, 3));
});

test("the time budget stops the run from drafting another theme", async () => {
  const { fetcher, groqBodies } = fakeFetch(() => [primary], [decline(firstTheme)]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher, { deadline: Date.now() + 10_000 });
  assert.equal(outcome.decision.shouldPost, false);
  assert.deepEqual(outcome.themesTried, [firstTheme]);
  assert.equal(groqBodies.length, 1);
});

test("a theme rejected twice gives way to the next theme, and its attempts travel with the outcome", async () => {
  const withDash = decisionJson({ paragraphs: { hook: `${hook} — really`, context: filler.repeat(6), insight: filler.repeat(5), takeaway: "Rule.", question } });
  const { fetcher } = fakeFetch(() => [primary], [withDash, withDash, decisionJson({ theme: secondTheme })]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(outcome.decision.shouldPost, true);
  assert.equal(outcome.theme, secondTheme);
  assert.equal(outcome.attempts.length, 2);
});

test("a night where every drafted theme is rejected fails with every attempt", async () => {
  const withDash = decisionJson({ paragraphs: { hook: `${hook} — really`, context: filler.repeat(6), insight: filler.repeat(5), takeaway: "Rule.", question } });
  const { fetcher } = fakeFetch(() => [primary], Array(6).fill(withDash));
  await assert.rejects(
    () => generateGroundedDraft(noRecent, now, fetcher),
    (error: unknown) => error instanceof DraftRejectedError && error.attempts.length === 6 && error.theme === themeOrder([], now)[2],
  );
});

test("retries once with compact evidence when Groq refuses the request as too large", async () => {
  const many = Array.from({ length: 7 }, (_, index) => ({ ...primary, url: `https://nextjs.org/blog/post-${index}` }));
  const { fetcher, groqBodies } = fakeFetch(() => many, ["__413__", decisionJson({ sourceUrls: [many[0]!.url] })]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(outcome.decision.shouldPost, true);
  assert.equal(groqBodies.length, 2);
  assert.equal((groqBodies[0]!.match(/"tier":/g) ?? []).length, 6);
  assert.equal((groqBodies[1]!.match(/"tier":/g) ?? []).length, 4);
  assert.equal(outcome.attempts.length, 0, "a size retry is not a rejected draft");
});

test("a second oversized refusal is fatal", async () => {
  const { fetcher } = fakeFetch(() => [primary], ["__413__", "__413__"]);
  await assert.rejects(() => generateGroundedDraft(noRecent, now, fetcher), GroqRequestTooLargeError);
});

test("an empty strict-JSON answer is retried with low reasoning effort, then fed back", async () => {
  const { fetcher, groqBodies, groqRequests } = fakeFetch(() => [primary], ["__400json__", "__400json__", decisionJson()]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(outcome.decision.shouldPost, true);
  assert.deepEqual(groqRequests.map((request) => request.reasoning_effort), ["medium", "low", "low"]);
  assert.equal(groqRequests[0]!.max_completion_tokens, 3000);
  assert.equal(outcome.attempts.length, 1, "the low-reasoning retry is free; the second failure counts");
  assert.match(groqBodies[2]!, /previous answer was empty, most likely because the reasoning used the whole budget/);
});

// Every paragraph field holding a copy of the whole paragraph object, as a live run
// answered twice in a row.
function nestedParagraphs(json: string) {
  const parsed = JSON.parse(json);
  const fields = Object.keys(parsed.paragraphs);
  const empty = Object.fromEntries(fields.map((field) => [field, ""]));
  parsed.paragraphs = Object.fromEntries(fields.map((field) => [field, { ...empty, [field]: parsed.paragraphs[field] }]));
  return JSON.stringify(parsed);
}

test("an answer with nested paragraph objects is unwrapped without another request", async () => {
  const { fetcher, groqRequests } = fakeFetch(() => [primary], [`__400json__:${nestedParagraphs(decisionJson())}`]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(groqRequests.length, 1);
  assert.equal(outcome.attempts.length, 0);
  assert.equal(postedText(outcome).startsWith(hook), true);
});

test("complete JSON in the wrong shape gets specific feedback and is not echoed back", async () => {
  const parsed = JSON.parse(decisionJson());
  parsed.paragraphs.hook = { context: "One text.", insight: "Another text." };
  const { fetcher, groqBodies, groqRequests } = fakeFetch(() => [primary], [`__400json__:${JSON.stringify(parsed)}`, decisionJson()]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(outcome.decision.shouldPost, true);
  assert.deepEqual(groqRequests.map((request) => request.reasoning_effort), ["medium", "medium"], "less reasoning would not fix the shape");
  assert.match(groqBodies[1]!, /paragraphs\.hook: [^;]*expected string/);
  assert.match(groqBodies[1]!, /one plain string, never an object or an array/);
  assert.doesNotMatch(groqBodies[1]!, /Another text/);
});

test("a cut-off answer still gets the free low-effort retry", async () => {
  const { fetcher, groqRequests } = fakeFetch(() => [primary], [`__400json__:${decisionJson().slice(0, 80)}`, decisionJson()]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(outcome.decision.shouldPost, true);
  assert.deepEqual(groqRequests.map((request) => request.reasoning_effort), ["medium", "low"]);
  assert.equal(outcome.attempts.length, 0);
});

test("only dated sources and their publishers' reference pages reach the prompt", async () => {
  const docs = { ...primary, title: "Next.js docs", url: "https://nextjs.org/docs/app/api-reference/config" };
  const readme = { ...primary, title: "A README", url: "https://github.com/someone/tool" };
  const { fetcher, groqBodies } = fakeFetch(() => [listicle, readme, docs, primary], [decisionJson()]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(outcome.decision.shouldPost, true);
  assert.match(groqBodies[0]!, /nextjs\.org\/blog\/next-16-3/);
  assert.match(groqBodies[0]!, /nextjs\.org\/docs\/app/);
  assert.doesNotMatch(groqBodies[0]!, /github\.com\/someone\/tool|aimultiple/);
});

const postedText = (outcome: Awaited<ReturnType<typeof generateGroundedDraft>>) =>
  outcome.decision.shouldPost ? outcome.decision.text : "";

test("the review pass can pull a claim back, and the reviewed draft is what ships", async () => {
  const softened = decisionJson({ paragraphs: { hook: "Bun is the first runtime I would trial for a Next.js dev loop.", context: filler.repeat(6), insight: filler.repeat(5), takeaway: "One rule: stream early.", question } });
  const { fetcher, groqBodies, reviewBodies } = fakeFetch(() => [primary], [decisionJson(), `__review__:${softened}`]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.match(postedText(outcome), /first runtime I would trial/);
  assert.equal(groqBodies.length, 1);
  assert.equal(reviewBodies.length, 1);
  assert.match(reviewBodies[0]!, /Hard rules\./);
  assert.match(reviewBodies[0]!, /<draft>\n\{"shouldPost":true/);
  assert.match(reviewBodies[0]!, /nextjs\.org\/blog\/next-16-3/);
  assert.deepEqual(outcome.notes, ["Review pass rewrote unsupported claims."]);
});

test("an unchanged review leaves no note", async () => {
  const { fetcher } = fakeFetch(() => [primary], [decisionJson()]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(postedText(outcome).startsWith(hook), true);
  assert.deepEqual(outcome.notes, []);
});

test("a review that declines the story moves on to the next theme", async () => {
  const { fetcher } = fakeFetch(() => [primary], [
    decisionJson(), `__review__:${decline(firstTheme, "The hook rests on a hello-world benchmark.")}`, decisionJson({ theme: secondTheme }),
  ]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(outcome.decision.shouldPost, true);
  assert.equal(outcome.theme, secondTheme);
});

test("a review rewrite that breaks a rule is dropped and the validated draft ships", async () => {
  const broken = decisionJson({ paragraphs: { hook: `${hook} — really`, context: filler.repeat(6), insight: filler.repeat(5), takeaway: "Rule.", question } });
  const { fetcher } = fakeFetch(() => [primary], [decisionJson(), `__review__:${broken}`]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(postedText(outcome).startsWith(hook), true);
  assert.match(outcome.notes?.[0] ?? "", /Review rewrite dropped because it broke a rule/);
});

test("a failing review call never costs the night", async () => {
  const { fetcher, reviewRequests } = fakeFetch(() => [primary], [decisionJson(), "__review__:__400json__", "__review__:__400json__"]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(postedText(outcome).startsWith(hook), true);
  assert.match(outcome.notes?.[0] ?? "", /Review pass skipped/);
  assert.equal(reviewRequests.length, 2);
});

test("an empty strict-JSON review is retried once with low reasoning effort", async () => {
  const { fetcher, reviewRequests } = fakeFetch(() => [primary], [decisionJson(), "__review__:__400json__"]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(postedText(outcome).startsWith(hook), true);
  assert.deepEqual(outcome.notes, []);
  assert.deepEqual(reviewRequests.map((request) => request.reasoning_effort), ["medium", "low"]);
  assert.deepEqual(reviewRequests.map((request) => request.max_completion_tokens), [3000, 3000]);
});

test("a nested review answer is unwrapped instead of skipped", async () => {
  const { fetcher, reviewRequests } = fakeFetch(() => [primary], [decisionJson(), `__review__:__400json__:${nestedParagraphs(decisionJson())}`]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(postedText(outcome).startsWith(hook), true);
  assert.deepEqual(outcome.notes, []);
  assert.equal(reviewRequests.length, 1);
});

const verge = { title: "A Verge story", url: "https://www.theverge.com/2026/9/4/streaming-ui", content: "Streaming UI coverage.", published_date: "2026-09-04T09:00:00Z" };
const techcrunch = { title: "An unrelated TechCrunch story", url: "https://techcrunch.com/2026/09/04/other-news", content: "Something else.", published_date: "2026-09-04T09:00:00Z" };

test("a review that drops an unrelated source the bar depended on declines the story", async () => {
  const cited = decisionJson({ sourceUrls: [verge.url, techcrunch.url] });
  const { fetcher } = fakeFetch((theme) => theme === firstTheme ? [verge, techcrunch] : [], [
    cited, `__review__:${decisionJson({ sourceUrls: [verge.url] })}`,
  ]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(outcome.decision.shouldPost, false);
  assert.match(outcome.decision.reason, /does not report this story \(An unrelated TechCrunch story\)/);
});

test("a review that drops an unrelated source keeps the story when a first-party source remains", async () => {
  const cited = decisionJson({ sourceUrls: [primary.url, techcrunch.url] });
  const { fetcher } = fakeFetch(() => [primary, techcrunch], [cited, `__review__:${decisionJson()}`]);
  const outcome = await generateGroundedDraft(noRecent, now, fetcher);
  assert.equal(outcome.decision.shouldPost, true);
  assert.deepEqual(outcome.decision.shouldPost && outcome.decision.sources.map((source) => source.url), [primary.url]);
});

test("a search that hangs is cut off at the run's deadline", { timeout: 5_000 }, async (t) => {
  // A real hung request holds a socket open; this fake holds nothing, and the deadline's
  // timer does not keep the process alive, so the test keeps it alive itself.
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  // Answers only when the request is aborted, as a hung connection would.
  const hanging: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  });
  const started = Date.now();
  await assert.rejects(() => generateGroundedDraft(noRecent, now, hanging, { deadline: Date.now() + 100 }));
  assert.ok(Date.now() - started < 2_000, "the deadline, not the per-call timeout, ended the search");
});
