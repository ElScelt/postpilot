// Canned Tavily and Groq answers for `npm run draft -- --offline`, so the whole drafting
// pipeline (research merge, source tiers, validator, corrective retry, review pass) can
// be run without API keys or network. The evidence describes a made-up release and is
// labelled as such; nothing here is real news.
import { groqEndpoint } from "../src/lib/drafting/groq";
import { isoDay, dayMs } from "../src/lib/scheduling/time";

const primaryUrl = "https://nodejs.org/en/blog/release/offline-sample";

function evidence(now: Date) {
  const publishedDate = isoDay(now.getTime() - dayMs);
  return [
    {
      title: "[Offline sample] Test runner: affected-only reruns in watch mode",
      url: primaryUrl,
      content: "Offline sample data. The built-in test runner can trace which test files import a changed module "
        + "and rerun only those files in watch mode. In a sample suite of 1,200 tests, a rerun after a one-file "
        + "change dropped from 48 seconds to 6 seconds. Dynamic imports are not traced.",
      published_date: publishedDate,
    },
    {
      title: "[Offline sample] Node.js test runner learns affected-only reruns",
      url: "https://www.infoq.com/news/offline-sample-node-test-runner/",
      content: "Offline sample data. The Node.js test runner now reruns only the test files affected by a change "
        + "when run in watch mode, according to the project's release notes.",
      published_date: publishedDate,
    },
  ];
}

const paragraphs = {
  hook: "Watch mode that reruns only the affected tests changes how I would structure a Node.js test suite.",
  context: "The Node.js project says the built-in test runner can trace which test files import a changed module "
    + "and rerun only those files in watch mode. Its sample suite of 1,200 tests went from 48 seconds to 6 seconds "
    + "per rerun after a one-file change.",
  insight: "That figure comes from a single synthetic suite, so the real gain depends on how tangled the import graph "
    + "is. A shared setup module imported everywhere turns every change into a full rerun, and dynamic imports can "
    + "hide a dependency from the tracer, which means a green rerun might skip the test that would have failed.",
  takeaway: "Keep shared fixtures out of the import path of unrelated tests.\n"
    + "Run the full suite in CI on every push, whatever watch mode skips.\n"
    + "Log which files a rerun selected so a skipped failure is traceable.",
  question: "Would you trust affected-only reruns locally if CI still runs everything, or does the gap between the "
    + "two worry you more?",
};

function completion(content: string) {
  return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
}

// Answers Tavily searches with the sample evidence, the drafting prompt with a draft on
// whichever theme the prompt names, and the review pass by returning the draft unchanged.
export function createOfflineFetch(now = new Date()): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://api.tavily.com/")) return Response.json({ results: evidence(now) });
    if (url !== groqEndpoint) throw new Error(`Offline mode has no canned answer for ${url}.`);
    const prompt: string = JSON.parse(String(init?.body)).messages[0].content;
    const reviewed = prompt.match(/<draft>\n([\s\S]*)\n<\/draft>$/);
    if (prompt.startsWith("Review a LinkedIn post") && reviewed) return completion(reviewed[1]!);
    const theme = prompt.match(/Report "([^"]+)" in the theme field/)?.[1] ?? "";
    return completion(JSON.stringify({
      shouldPost: true,
      reason: "Offline sample evidence clears the bar.",
      topic: "Affected-only test reruns",
      theme,
      paragraphs,
      sourceUrls: [primaryUrl],
    }));
  };
}

// The request builders read these even though nothing leaves the machine.
export function setOfflineCredentials() {
  process.env.GROQ_API_KEY ||= "offline";
  process.env.TAVILY_API_KEY ||= "offline";
}
