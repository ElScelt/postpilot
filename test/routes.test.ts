import test from "node:test";
import assert from "node:assert/strict";
import * as run from "../src/app/api/automation/run/route";
import * as publish from "../src/app/api/cron/publish/route";
import * as reject from "../src/app/api/posts/reject/route";
import * as callback from "../src/app/api/auth/linkedin/callback/route";
import * as connect from "../src/app/api/auth/linkedin/route";
import { validState } from "../src/lib/linkedin/oauth";
import { publishTimeLimitSeconds, runTimeLimitSeconds } from "../src/lib/limits";

// The route files only wire Next to the handlers the other suites test. This checks the
// wiring: the methods each route answers, and the time limits Next reads from them.
test("each route exports the methods it answers and nothing else", () => {
  assert.deepEqual(Object.keys(run).sort(), ["POST", "maxDuration"]);
  assert.deepEqual(Object.keys(publish).sort(), ["POST", "maxDuration"]);
  assert.deepEqual(Object.keys(reject).sort(), ["GET", "POST"]);
  assert.deepEqual(Object.keys(callback).sort(), ["GET"]);
  assert.deepEqual(Object.keys(connect).sort(), ["GET"]);
});

test("the routes' time limits are the ones the run and publish logic assume", () => {
  assert.equal(run.maxDuration, runTimeLimitSeconds);
  assert.equal(publish.maxDuration, publishTimeLimitSeconds);
});

test("connecting LinkedIn sends the owner to the consent screen with a signed state cookie", async () => {
  process.env.LINKEDIN_STATE_SECRET = "state-secret";
  process.env.LINKEDIN_CLIENT_ID = "client";
  process.env.LINKEDIN_REDIRECT_URI = "https://example.vercel.app/api/auth/linkedin/callback";
  const response = await connect.GET();
  const target = new URL(response.headers.get("location")!);
  assert.equal(target.origin + target.pathname, "https://www.linkedin.com/oauth/v2/authorization");
  assert.equal(target.searchParams.get("scope"), "openid profile w_member_social");
  const state = target.searchParams.get("state");
  assert.ok(validState(state));
  assert.match(response.headers.get("set-cookie") ?? "", new RegExp(`postpilot_oauth_state=${state}; .*HttpOnly`, "i"));
});
