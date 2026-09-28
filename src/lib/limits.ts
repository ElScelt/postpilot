// Numbers several layers must agree on. This module imports nothing, so the validator,
// the post store and the route handlers can all read them without pulling in a client.

// LinkedIn's limit on the text of a post.
export const maxPostLength = 3000;

// The run route's maxDuration. The run lock and the drafting deadline are derived from
// it, so a run that the platform kills leaves nothing behind that outlives it. Next
// reads maxDuration statically, so route.ts repeats the number and a test pins the two.
export const runTimeLimitSeconds = 300;

// Every run, scheduled or started from the dashboard, is retried this many times with a
// fresh sample; the run route alerts only on the last attempt.
export const runRetries = 3;

// The morning publish is retried this many times, and its route's maxDuration is this
// limit; route.ts repeats the number and a test pins the two.
export const publishRetries = 3;
export const publishTimeLimitSeconds = 60;
