import test from "node:test";
import assert from "node:assert/strict";
import { checkSetup } from "../src/lib/setup-check";
import { requiredVariables } from "../src/lib/env";

const complete: Record<string, string> = {
  ...Object.fromEntries(requiredVariables.map((name) => [name, "x"])),
  APP_URL: "https://poster.example.com",
  LINKEDIN_REDIRECT_URI: "https://poster.example.com/api/auth/linkedin/callback",
  UPSTASH_REDIS_REST_URL: "https://redis.example.com",
  UPSTASH_REDIS_REST_TOKEN: "t",
  NTFY_TOPIC: "topic",
  HEALTHCHECK_URL: "https://hc-ping.com/abc",
};

const levels = (env: Record<string, string>, context = {}) => checkSetup(env, context).map((check) => check.level);
const texts = (env: Record<string, string>, context = {}) => checkSetup(env, context).map((check) => check.text).join("\n");

test("a complete configuration raises nothing", () => {
  assert.deepEqual(checkSetup(complete), []);
});

test("names every missing required variable at once", () => {
  const { GROQ_API_KEY: _groq, QSTASH_TOKEN: _qstash, ...env } = complete;
  assert.match(texts(env), /Missing required variables: GROQ_API_KEY, QSTASH_TOKEN\./);
  assert.deepEqual(levels(env), ["error"]);
});

test("flags missing Redis credentials", () => {
  const { UPSTASH_REDIS_REST_TOKEN: _token, ...env } = complete;
  assert.match(texts(env), /Redis is not configured/);
});

// The Vercel marketplace integration names them KV_REST_API_*; the live deployment this
// project grew out of has only those.
test("accepts the Redis variables the Vercel marketplace integration adds", () => {
  const { UPSTASH_REDIS_REST_URL: _url, UPSTASH_REDIS_REST_TOKEN: _token, ...env } = complete;
  assert.deepEqual(checkSetup({ ...env, KV_REST_API_URL: "https://redis.example.com", KV_REST_API_TOKEN: "t" }), []);
});

test("rejects an APP_URL that is not a bare https origin", () => {
  assert.match(texts({ ...complete, APP_URL: "http://poster.example.com" }), /must be an https origin/);
  assert.match(texts({ ...complete, APP_URL: "https://poster.example.com/" }), /no trailing slash/);
  assert.match(texts({ ...complete, APP_URL: "https://poster.example.com/api" }), /no path/);
  assert.match(texts({ ...complete, APP_URL: "not a url" }), /must be an https origin/);
});

test("expects the redirect URI to be the callback under APP_URL", () => {
  const env = { ...complete, LINKEDIN_REDIRECT_URI: "https://other.example.com/api/auth/linkedin/callback" };
  assert.match(texts(env), /LINKEDIN_REDIRECT_URI should be https:\/\/poster\.example\.com\/api\/auth\/linkedin\/callback/);
  assert.deepEqual(levels(env), ["error"]);
});

test("warns when the page is served from a host other than APP_URL, as a note on previews", () => {
  assert.deepEqual(levels(complete, { servingHost: "poster.example.com" }), []);
  assert.deepEqual(levels(complete, { servingHost: "preview.example.com" }), ["warning"]);
  assert.deepEqual(levels({ ...complete, VERCEL_ENV: "preview" }, { servingHost: "preview.example.com" }), ["note"]);
});

test("tells the owner which member id to pin once LinkedIn is connected", () => {
  assert.match(texts(complete, { memberId: "abc123" }), /Set LINKEDIN_MEMBER_ID to that value/);
  assert.deepEqual(checkSetup({ ...complete, LINKEDIN_MEMBER_ID: "abc123" }, { memberId: "abc123" }), []);
  assert.match(texts({ ...complete, LINKEDIN_MEMBER_ID: "zzz" }, { memberId: "abc123" }), /LINKEDIN_MEMBER_ID is zzz but the connected member is abc123/);
  assert.deepEqual(checkSetup({ ...complete, LINKEDIN_MEMBER_ID: "abc123" }), []);
});

test("flags the optional variables only when they are set wrongly or worth knowing about", () => {
  assert.match(texts({ ...complete, GROQ_MODEL: "llama-3.3-70b-versatile" }), /GROQ_MODEL "llama-3.3-70b-versatile" is not supported/);
  assert.deepEqual(checkSetup({ ...complete, GROQ_MODEL: "openai/gpt-oss-120b" }), []);
  const { NTFY_TOPIC: _topic, HEALTHCHECK_URL: _heartbeat, ...quiet } = complete;
  assert.deepEqual(levels(quiet), ["warning", "note"]);
});
