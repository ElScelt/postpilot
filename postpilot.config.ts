import type { PostpilotConfig } from "./src/lib/config";

// What gets posted and when. Every field is optional; anything left out falls back to
// the default shown in the README's configuration table. Secrets never go here: they
// belong in environment variables (see .env.example).
const config: PostpilotConfig = {
  // IANA time zone for the schedule and every timestamp postpilot shows you.
  timeZone: "UTC",
  // Hour (0-23) the post goes out the morning after a run.
  publishHour: 9,
  // When research and drafting run. The evening before publishing leaves the night to
  // read the draft and reject it.
  schedule: { days: ["sun", "tue", "thu"], runHour: 21 },
  persona: {
    role: "working software developer who builds products for a living",
  },
};

export default config;
