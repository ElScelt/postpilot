import test from "node:test";
import assert from "node:assert/strict";
import { draftJsonProblem, repairDraftJson } from "../src/lib/drafting/decision";
import { themeIds } from "../src/lib/research/themes";

const paragraphs = { hook: "Hook.", context: "Context.", insight: "Insight.", takeaway: "Takeaway.", question: "Question?" };
const answer = (overrides: Record<string, unknown>) => JSON.stringify({
  shouldPost: true, reason: "fresh", topic: "Topic", theme: themeIds()[0], paragraphs, sourceUrls: [], ...overrides,
});
const empty = { hook: "", context: "", insight: "", takeaway: "", question: "" };

test("paragraph objects nested inside every field are unwrapped", () => {
  // Both shapes a live run produced: the field's own key filled, or only one other key.
  const own = Object.fromEntries(Object.entries(paragraphs).map(([field, text]) => [field, { ...empty, [field]: text }]));
  const stray = Object.fromEntries(Object.entries(paragraphs).map(([field, text]) => [field, { ...empty, context: text }]));
  for (const nested of [own, stray]) {
    assert.deepEqual(JSON.parse(repairDraftJson(answer({ paragraphs: nested }))!).paragraphs, paragraphs);
  }
});

test("a checklist sent as an array becomes one line per item", () => {
  const repaired = repairDraftJson(answer({ paragraphs: { ...paragraphs, takeaway: ["Pin the version", " Add a test "] } }));
  assert.equal(JSON.parse(repaired!).paragraphs.takeaway, "Pin the version\nAdd a test");
});

test("nothing is guessed: ambiguous, well-formed or unparseable answers are not repaired", () => {
  assert.equal(repairDraftJson(answer({ paragraphs: { ...paragraphs, hook: { context: "One.", insight: "Two." } } })), undefined);
  assert.equal(repairDraftJson(answer({})), undefined);
  assert.equal(repairDraftJson("{\"shouldPost\": tru"), undefined);
  assert.equal(repairDraftJson(answer({ theme: "not-a-theme", paragraphs: { ...paragraphs, hook: { hook: "Hook." } } })), undefined);
});

test("the correction names what was wrong with the answer", () => {
  assert.match(draftJsonProblem(""), /was empty/);
  assert.match(draftJsonProblem("{\"shouldPost\": tru"), /not valid JSON \(it was cut off or malformed\)/);
  assert.match(draftJsonProblem(answer({ paragraphs: { ...paragraphs, hook: { a: 1 } } })), /paragraphs\.hook: [^;]*expected string/);
});
