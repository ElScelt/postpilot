// Research and draft one post locally without scheduling, notifying, or touching Redis,
// so prompt and validator changes can be judged before a real run. Needs GROQ_API_KEY
// and TAVILY_API_KEY, typically from .env.local, unless --offline is passed:
//
//   npm run draft                # least recently used theme by the calendar
//   npm run draft -- testing     # force a theme
//   npm run draft -- --offline   # canned responses, no keys or network needed
import { DraftRejectedError, generateGroundedDraft } from "../src/lib/drafting/pipeline";
import { isPostTheme, themeIds } from "../src/lib/research/themes";
import { createOfflineFetch, setOfflineCredentials } from "./offline";

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const requested = args.find((arg) => !arg.startsWith("--"));
  if (requested && !isPostTheme(requested)) {
    console.error(`Unknown theme "${requested}". Choose one of: ${themeIds().join(", ")}.`);
    process.exit(1);
  }

  // Listing every other theme as recently used makes the requested one least recent.
  const recent = {
    posts: [], topics: [], sourceUrls: [],
    themes: requested ? themeIds().filter((theme) => theme !== requested) : [],
  };

  const now = new Date();
  if (offline) {
    setOfflineCredentials();
    console.log("Offline mode: canned search results and model answers, not real news.\n");
  }

  try {
    const outcome = await generateGroundedDraft(recent, now, offline ? createOfflineFetch(now) : fetch);
    console.log(JSON.stringify({
      theme: outcome.theme,
      themesTried: outcome.themesTried,
      evidenceHosts: outcome.evidenceHosts,
      rejectedAttempts: outcome.attempts,
      notes: outcome.notes,
      decision: outcome.decision,
    }, null, 2));
    if (outcome.decision.shouldPost) {
      console.log("\n----- draft -----\n");
      console.log(outcome.decision.text);
    } else if (offline) {
      // The canned draft always clears the bar, so a skip means the pipeline changed.
      process.exit(3);
    }
  } catch (error) {
    if (error instanceof DraftRejectedError) {
      console.error(`Both drafts on theme ${error.theme} failed validation.`);
      for (const attempt of error.attempts) {
        console.error(`\n----- rejected: ${attempt.reason}\n\n${attempt.text}`);
      }
      process.exit(2);
    }
    throw error;
  }
}

void main();
