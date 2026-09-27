import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewRequest, draftAsJson, reviewPrompt } from "../src/lib/drafting/review";

process.env.GROQ_API_KEY = "test-key";
delete process.env.GROQ_MODEL;

const draft = {
  shouldPost: true as const,
  reason: "fresh",
  topic: "Bun as a dev runtime",
  theme: "frontend" as const,
  text: "Hook.\n\nContext.\n\nInsight.\n\nRule one.\nRule two.\n\nQuestion?",
  sources: [{ title: "Bun 1.4", url: "https://bun.sh/blog/bun-v1.4", publishedDate: "2026-08-20", primary: true }],
};

test("the draft is handed back in the schema's shape", () => {
  assert.deepEqual(JSON.parse(draftAsJson(draft)), {
    shouldPost: true, reason: "fresh", topic: "Bun as a dev runtime", theme: "frontend",
    paragraphs: { hook: "Hook.", context: "Context.", insight: "Insight.", takeaway: "Rule one.\nRule two.", question: "Question?" },
    sourceUrls: ["https://bun.sh/blog/bun-v1.4"],
  });
});

test("the review sees the hard rules, the evidence and the draft, and answers in the same schema", () => {
  const evidence = [{ title: "Bun 1.4", url: draft.sources[0]!.url, publishedDate: "2026-08-20", content: "hello.js starts in 15.5 ms." }];
  const prompt = reviewPrompt(draft, evidence, new Date("2026-09-03T18:00:00.000Z"));
  assert.match(prompt, /Hard rules\. A validator checks/);
  assert.match(prompt, /15\.5 ms/);
  assert.match(prompt, /hello-world startup benchmark is not a faster development loop/);
  assert.match(prompt, /<draft>\n\{"shouldPost":true/);
  const body = JSON.parse(String(buildReviewRequest(draft, evidence, new Date()).body));
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.max_completion_tokens, 2500);
});
