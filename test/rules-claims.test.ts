import test from "node:test";
import assert from "node:assert/strict";
import { draftViolations } from "../src/lib/drafting/rules";

// What the claim rules catch and what they let through, sentence by sentence, so the
// patterns can be restructured without anyone having to re-derive their behaviour.
// A row whose result looks wrong is still what the validator does today.

const now = new Date("2026-07-14");
const source = { title: "Announcement", url: "https://openai.com/index/announcement", publishedDate: "2026-07-10", primary: true };
const filler = "Agent reliability depends on permissions, observable tool use, and controlled execution boundaries. ";
const body = `${filler.repeat(6)}\n\n${filler.repeat(5)}`;
const hook = "Streaming the first token early matters more than raw speed.";
const question = "Where does your production workflow need a stronger boundary?";

function violations(text: string) {
  return draftViolations({ text, topic: "Agents", sources: [source] }, now);
}

const claimsExperienceInHook = (sentence: string) =>
  violations(`${sentence}\n\n${body}\n\n${question}`).some((violation) => violation.startsWith("Hook claims personal testing"));

const statesInventedHistory = (sentence: string) =>
  violations(`${hook}\n\n${sentence}\n\n${body}\n\n${question}`).some((violation) => violation.startsWith("Draft states invented history"));

const hookRows: Array<[string, boolean]> = [
  ["I tested Bun against Node on a cold start.", true],
  ["We've just migrated the API to Hono.", true],
  ["I have been using Deno for a month.", true],
  ["We finally switched to pnpm workspaces.", true],
  ["I've already deployed the fix.", true],
  ["We cut the bundle by a third.", true],
  ["I found the regression in the router.", true],
  ["We recently migrated to Hono.", false],
  ["I would test Bun before switching.", false],
  ["We should measure this before switching.", false],
  ["I'm switching to pnpm this quarter.", false],
  ["Teams that tested Bun saw faster installs.", false],
];

const historyRows: Array<[string, boolean]> = [
  // The first live test's queued post.
  ["Our component library renders dynamic OG images from user-provided text.", true],
  ["Our codebase was on Next.js 14, so the upgrade became mandatory.", true],
  ["Our code base has been on Node 18 for a year.", true],
  ["My team used to deploy on Fridays.", true],
  ["Our app runs on Vercel.", true],
  ["Our monorepo sits on Turborepo.", true],
  ["We rewrote the parser in Rust.", true],
  ["We recently migrated the queue to Redis.", true],
  ["I have been profiling the worker for a week.", true],
  ["Our frontend ships a large bundle.", true],
  ["Our pipeline has one slow job.", true],
  ["My API tests failed after the upgrade.", true],
  ["Our checkout service handled the spike.", true],
  // Every system the present-tense rule knows is also covered in the past tense.
  ["Our database had no index on that column.", true],
  ["My website used to render on the server.", true],
  ["If your app renders OG images, cache them.", false],
  ["Our app would need a queue for this.", false],
  ["Our app needs a queue for this.", false],
  ["Our app users expect fast pages.", false],
  ["Our team should measure it first.", false],
  ["Your codebase was on Next.js 14.", false],
  ["Our stack is TypeScript end to end.", false],
  ["Our dashboard pages load in one request.", false],
  ["Our app can stream the response.", false],
  ["I would rewrite the parser before scaling it.", false],
];

test("personal testing claims in the hook", () => {
  for (const [sentence, expected] of hookRows) {
    assert.equal(claimsExperienceInHook(sentence), expected, sentence);
  }
});

test("invented history and claims about the author's own systems", () => {
  for (const [sentence, expected] of historyRows) {
    assert.equal(statesInventedHistory(sentence), expected, sentence);
  }
});
