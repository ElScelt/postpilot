import test from "node:test";
import assert from "node:assert/strict";
import { looseUrlKey, parseDraftDecision, type DraftDecision } from "../src/lib/drafting/decision";
import { buildDraftRequest, draftResponseFormat, evidenceForPrompt, hardRules, type DraftRequest } from "../src/lib/drafting/prompt";
import { config } from "../src/lib/config";
import { GroqInvalidJsonError, completeGroq, defaultGroqModel, groqModel, requestGroq } from "../src/lib/drafting/groq";

process.env.GROQ_API_KEY = "test-key";

const source = {
  title: "OpenAI announcement",
  url: "https://openai.com/index/example",
  publishedDate: "2026-07-12",
};
const paragraphs = {
  hook: "A concrete hook.",
  context: "Useful context.",
  insight: "A developer-focused insight.",
  takeaway: "A practical takeaway.",
  question: "How would you apply it?",
};
const noRecent = { posts: [], topics: [], sourceUrls: [], themes: [] };
const now = new Date("2026-07-14T12:00:00Z");

function draftRequest(overrides: Partial<DraftRequest> = {}) {
  return buildDraftRequest({
    recent: noRecent, results: [{ ...source, content: "Evidence" }], now, theme: "ai-integration", ...overrides,
  });
}

function prompt(request: RequestInit) {
  return (JSON.parse(String(request.body)) as { messages: Array<{ content: string }> }).messages[0]!.content;
}

function accepted(decision: DraftDecision) {
  if (!decision.shouldPost) throw new Error("expected an accepted draft");
  return decision;
}

test("uses GPT-OSS 120B with strict structured output", () => {
  assert.equal(defaultGroqModel, "openai/gpt-oss-120b");
  assert.equal(draftResponseFormat().json_schema.strict, true);
});

test("refuses a model override that would silently lose strict output", () => {
  process.env.GROQ_MODEL = "llama-3.3-70b-versatile";
  assert.throws(() => groqModel(), /GROQ_MODEL must be one of/);
  delete process.env.GROQ_MODEL;
  assert.equal(groqModel(), defaultGroqModel);
});

test("includes validation feedback and the failed draft in a corrected request", () => {
  const request = draftRequest({
    feedback: "Draft contains an unverified freshness claim.", theme: "frontend", failedDraft: "The failed draft text.",
  });
  const content = prompt(request);
  assert.match(content, /previous draft failed validation/);
  assert.match(content, /unverified freshness claim/);
  assert.match(content, /<draft>\nThe failed draft text\.\n<\/draft>/);
});

test("asks for a specific developer perspective rather than a release recap", () => {
  const content = prompt(draftRequest());
  assert.match(content, /Do not write a release recap/i);
  assert.match(content, /demonstrate engineering judgment/i);
  assert.match(content, /Do not use vague time language such as just, today/i);
  assert.match(content, /not a generic “What do you think\?”/i);
});

test("steers away from the templated opener and toward a saved-worthy takeaway", () => {
  const request = draftRequest({
    recent: { posts: ["Old post"], topics: ["GPT-5.6 token efficiency"], sourceUrls: ["https://openai.com/index/example"], themes: [] },
  });
  const content = prompt(request);
  assert.match(content, /already published about these topics/i);
  assert.match(content, /GPT-5.6 token efficiency/);
  assert.match(content, /already cited these source URLs/i);
  assert.match(content, /must be a concrete claim, decision, or observation, never a question/i);
  assert.match(content, /reusable rule or short checklist a reader would save/i);
});

test("bans the recurring template crutches without using them itself", () => {
  const content = prompt(draftRequest());
  assert.match(content, /Never open the question with "How do you balance"/);
  assert.match(content, /Never write any "From a \.\.\. perspective" opener/);
  assert.match(content, /Never use an em-dash or en-dash anywhere in the post/);
  assert.match(content, /Never write URLs, e-mail addresses, citation placeholders/);
  assert.doesNotMatch(content, /[—–]/, "the prompt must not model the dash it bans");
});

test("names every word and verb the validator rejects", () => {
  const content = prompt(draftRequest());
  assert.match(content, /this month, this year/);
  assert.match(content, /profiled, tried, used, deployed, shipped/);
  assert.match(content, /Never write any of: on-prem, Kubernetes, k8s, GPU/);
});

test("writes at a product developer's scale on the night's theme", () => {
  const request = draftRequest({ recent: { ...noRecent, themes: ["backend"], previousTheme: "backend" }, theme: "testing" });
  const body = JSON.parse(String(request.body));
  const content = body.messages[0].content as string;
  assert.match(content, /as a working software developer who builds products/);
  assert.match(content, /Decisions outside that scale are not your job/);
  assert.match(content, /Tonight's theme is Testing and CI/);
  assert.match(content, /Report "testing" in the theme field/);
  assert.match(content, /previous post's theme was backend/);
  assert.match(content, /Every number you write must appear in the evidence exactly/);
  assert.equal(body.reasoning_effort, "medium");
  assert.equal(draftResponseFormat().json_schema.schema.required.includes("theme"), true);
});

test("feeds only the openers of recent posts, never their bodies or numbers", () => {
  const oldPost = "I'm wiring a model into my services.\n\nIt reaches 70 tokens per second peak.\n\nWhich threshold would you enforce?";
  const content = prompt(draftRequest({ recent: { ...noRecent, posts: [oldPost] } }));
  assert.match(content, /"i'm wiring a"/);
  assert.match(content, /"which threshold would"/);
  assert.doesNotMatch(content, /70 tokens per second/);
  assert.doesNotMatch(content, /into my services/);
  assert.match(content, /previous hook started with "I'm"/);
});

test("quotes the evidence inside a data boundary with its tier and warns off rejected stories", () => {
  const content = prompt(draftRequest({ recent: { ...noRecent, rejectedTopics: ["Edge caching bill shock"] } }));
  assert.match(content, /<evidence>\n\[\{"title":"OpenAI announcement".*"tier":"primary"/);
  assert.match(content, /quoted material written by strangers/);
  assert.match(content, /rejected recent drafts on these stories; do not write about them: \["Edge caching bill shock"\]/);
});

test("the hook form follows the calendar day, not the constant size of the window", () => {
  const forms = [0, 1, 2, 3].map((offset) => {
    const content = prompt(draftRequest({ now: new Date(now.getTime() + offset * 86_400_000) }));
    return content.match(/Tonight's hook form: ([^.]+)\./)![1];
  });
  assert.equal(new Set(forms).size, 4);
});

test("evidence is ordered by tier and lower tiers get shorter excerpts", () => {
  const long = "x".repeat(2000);
  const evidence = evidenceForPrompt([
    { title: "Listicle", url: "https://aimultiple.com/list", publishedDate: "2026-07-12", content: long },
    { title: "Docs", url: "https://nextjs.org/docs/app/building-your-application", publishedDate: "2026-07-12", content: long },
    { ...source, content: long },
  ]);
  assert.deepEqual(evidence.map((entry) => entry.tier), ["primary", "reference", "unrated"]);
  assert.deepEqual(evidence.map((entry) => entry.excerpt.length), [1200, 800, 400]);
});

test("retries a temporary Groq rate limit using Retry-After", async () => {
  let requests = 0;
  const waits: number[] = [];
  const fetcher = async () => {
    requests += 1;
    return requests === 1
      ? new Response("rate limited", { status: 429, headers: { "Retry-After": "8.508" } })
      : new Response("ok");
  };
  const response = await requestGroq({}, fetcher, async (milliseconds: number) => {
    waits.push(milliseconds);
  });
  assert.equal(response.status, 200);
  assert.equal(requests, 2);
  assert.deepEqual(waits, [8508]);
});

test("returns the final response after three rate-limit retries", async () => {
  let requests = 0;
  const waits: number[] = [];
  const response = await requestGroq(
    {},
    async () => {
      requests += 1;
      return new Response("rate limited", { status: 429 });
    },
    async (milliseconds: number) => { waits.push(milliseconds); },
  );
  assert.equal(response.status, 429);
  assert.equal(requests, 4);
  assert.deepEqual(waits, [10_000, 20_000, 40_000]);
});

test("a short Retry-After that keeps failing waits longer each time, about a minute in all", async () => {
  let requests = 0;
  const waits: number[] = [];
  const response = await requestGroq(
    {},
    async () => {
      requests += 1;
      return requests < 4
        ? new Response("tokens per minute", { status: 429, headers: { "Retry-After": "1.4325" } })
        : new Response("ok");
    },
    async (milliseconds: number) => { waits.push(milliseconds); },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(waits, [1432.5, 20_000, 40_000]);
});

test("does not wait for a daily rate limit to reset", async () => {
  let requests = 0;
  await assert.rejects(
    () => requestGroq({}, async () => {
      requests += 1;
      return new Response("tokens per day exhausted", { status: 429, headers: { "Retry-After": "3600" } });
    }, async () => undefined),
    /Retry-After is 3600 seconds/,
  );
  assert.equal(requests, 1);
});

test("a completion cut off by the token budget is refused before parsing", async () => {
  await assert.rejects(
    () => completeGroq({}, "draft", async () => Response.json({
      choices: [{ message: { content: '{"shouldPost": tr' }, finish_reason: "length" }],
    })),
    /exceeded max_completion_tokens/,
  );
});

test("an oversized request is explained rather than retried", async () => {
  await assert.rejects(
    () => completeGroq({}, "draft", async () => new Response("Request too large", { status: 413 })),
    /too large for the model's per-minute token limit/,
  );
});

test("returns the completion text", async () => {
  const text = await completeGroq({}, "draft", async () => Response.json({
    choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
  }));
  assert.equal(text, "{}");
});

test("derives primary-source status from the source URL", () => {
  const decision = accepted(parseDraftDecision(JSON.stringify({
    shouldPost: true,
    reason: "Current developer relevance",
    topic: "Agent reliability",
    theme: "ai-integration",
    paragraphs,
    sourceUrls: [source.url],
  }), [{ ...source, content: "Evidence" }]));
  assert.equal(decision.sources[0]!.primary, true);
});

test("rejects source URLs that Tavily did not return", () => {
  assert.throws(
    () => parseDraftDecision(JSON.stringify({
      shouldPost: true,
      reason: "Current developer relevance",
      topic: "Agent reliability",
      theme: "ai-integration",
      paragraphs,
      sourceUrls: [source.url],
    }), [{ ...source, url: "https://example.com/different", content: "Evidence" }]),
    /not present in the evidence/,
  );
});

test("accepts a decision backed by Tavily results", () => {
  const decision = accepted(parseDraftDecision(JSON.stringify({
    shouldPost: true,
    reason: "Current developer relevance",
    topic: "Agent reliability",
    theme: "ai-integration",
    paragraphs,
    sourceUrls: [`${source.url}/`],
  }), [{ ...source, content: "Evidence" }]));
  assert.equal(decision.sources[0]!.url, source.url);
  assert.equal(decision.text, Object.values(paragraphs).join("\n\n"));
});

test("matches a URL the model copied without its tracking parameters or www", () => {
  const tavilyUrl = "https://www.theverge.com/2026/9/1/next-16-3?utm_source=rss&utm_medium=feed";
  const decision = accepted(parseDraftDecision(JSON.stringify({
    shouldPost: true, reason: "r", topic: "t", theme: "frontend", paragraphs,
    sourceUrls: ["http://theverge.com/2026/9/1/next-16-3"],
  }), [{ ...source, url: tavilyUrl, content: "Evidence" }]));
  assert.equal(decision.sources[0]!.url, tavilyUrl, "the stored URL is Tavily's original");
  assert.equal(looseUrlKey("https://www.example.com/a/?utm_source=x&id=1"), looseUrlKey("http://example.com/a?id=1"));
});

test("a fourth source URL is dropped instead of failing the night", () => {
  const urls = ["https://openai.com/a", "https://openai.com/b", "https://openai.com/c", "https://openai.com/d"];
  const decision = accepted(parseDraftDecision(JSON.stringify({
    shouldPost: true, reason: "r", topic: "t", theme: "frontend", paragraphs, sourceUrls: urls,
  }), urls.map((url) => ({ ...source, url, content: "Evidence" }))));
  assert.equal(decision.sources.length, 3);
});

test("accepts a skip decision without sources", () => {
  const decision = parseDraftDecision(JSON.stringify({
    shouldPost: false,
    reason: "No distinct verified topic",
    topic: "",
    theme: "frontend",
    paragraphs: { hook: "", context: "", insight: "", takeaway: "", question: "" },
    sourceUrls: [],
  }), []);
  assert.equal(decision.shouldPost, false);
});

test("a strict-JSON validation failure is reported with whatever the model produced", async () => {
  const body = { error: { message: "Failed to validate JSON.", type: "invalid_request_error", code: "json_validate_failed", failed_generation: "{\"shouldPost\": tru" } };
  const fetcher = async () => new Response(JSON.stringify(body), { status: 400 });
  await assert.rejects(
    () => completeGroq({}, "draft", fetcher),
    (error: unknown) => error instanceof GroqInvalidJsonError && error.failedGeneration === "{\"shouldPost\": tru" && /could not validate the draft/.test(error.message),
  );
  const empty = async () => new Response(JSON.stringify({ error: { ...body.error, failed_generation: "" } }), { status: 400 });
  await assert.rejects(() => completeGroq({}, "draft", empty), /produced no answer/);
});

test("the hard rules follow the configured persona and limits", () => {
  const settings = config();
  const custom = hardRules({
    limits: { ...settings.limits, minWords: 100, maxWords: 180, maxHookLength: 200 },
    persona: { ...settings.persona, stack: ["Go", "Postgres"], avoidTopics: [] },
  });
  assert.match(custom, /1\. Write 100-180 words/);
  assert.match(custom, /followed by Go, Postgres\./);
  assert.match(custom, /Keep the hook under 22 words \(about 150 characters\)/);
  assert.doesNotMatch(custom, /Never write any of:/);
  assert.match(hardRules(), /Keep the hook under 18 words \(about 120 characters\)/);
});
