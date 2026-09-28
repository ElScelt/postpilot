import test from "node:test";
import assert from "node:assert/strict";
import { escapeCommentary, LinkedInPublishError, linkedInApiVersions, linkedInTokenStatus, publishTextPost, requireToken } from "../src/lib/linkedin/api";

const day = 86_400_000;
const now = Date.parse("2026-07-29T00:00:00Z");
const store = (expiresAt?: number) => ({
  get: async <T,>() => (expiresAt === undefined ? null : { accessToken: "x", memberId: "y", expiresAt } as T),
});

test("reports a missing LinkedIn connection", async () => {
  assert.deepEqual(await linkedInTokenStatus(now, store()), { state: "missing" });
});

test("counts the days left on a live authorization", async () => {
  assert.deepEqual(await linkedInTokenStatus(now, store(now + 44 * day)), { state: "valid", daysRemaining: 44 });
});

test("reports how long ago an authorization lapsed", async () => {
  assert.deepEqual(await linkedInTokenStatus(now, store(now - 3 * day)), { state: "expired", daysRemaining: -3 });
});

test("treats an authorization expiring this instant as expired", async () => {
  assert.equal((await linkedInTokenStatus(now, store(now))).state, "expired");
});

test("a token that dies overnight is valid at draft time and expired at publish time", async () => {
  const draftTime = Date.parse("2026-09-06T18:00:00Z");
  const publishTime = Date.parse("2026-09-07T07:00:00Z");
  const expiresAt = Date.parse("2026-09-07T00:00:00Z");
  assert.deepEqual(await linkedInTokenStatus(draftTime, store(expiresAt)), { state: "valid", daysRemaining: 0 });
  assert.equal((await linkedInTokenStatus(publishTime, store(expiresAt))).state, "expired");
});

test("requireToken refuses a missing or expired authorization", async () => {
  await assert.rejects(() => requireToken(store()), /not connected/);
  await assert.rejects(() => requireToken(store(Date.now() - day)), /expired/);
});

test("commentary escapes the characters LinkedIn reserves for little text format", () => {
  assert.equal(
    escapeCommentary("adopt an SDK only if it (a) covers your models_and adapters"),
    "adopt an SDK only if it \\(a\\) covers your models\\_and adapters",
  );
});

test("commentary escapes every reserved character exactly once", () => {
  const reserved = "\\|{}@[]()<>#*_~";
  assert.equal(escapeCommentary(reserved), [...reserved].map((character) => `\\${character}`).join(""));
  assert.equal(
    escapeCommentary("upgrade @types/node, then a | b and Record<string, T> in #!/usr/bin/env"),
    "upgrade \\@types/node, then a \\| b and Record\\<string, T\\> in \\#!/usr/bin/env",
  );
});

test("commentary escapes a backslash exactly once", () => {
  assert.equal(escapeCommentary("a \\ b"), "a \\\\ b");
});

test("commentary leaves ordinary punctuation and em dashes untouched", () => {
  const text = "I'm standardizing on Frontier—it ships one SDK. Worth it?";
  assert.equal(escapeCommentary(text), text);
});

test("publishes escaped commentary as the connected member with the pinned API version", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    captured = { url: String(input), init };
    return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:123" } });
  };
  const id = await publishTextPost("adopt (a) SDK", fetcher, store(Date.now() + day));
  assert.equal(id, "urn:li:share:123");
  assert.equal(captured?.url, "https://api.linkedin.com/rest/posts");
  const headers = captured?.init?.headers as Record<string, string>;
  assert.equal(headers["Linkedin-Version"], linkedInApiVersions[0]);
  assert.equal(headers.Authorization, "Bearer x");
  const body = JSON.parse(String(captured?.init?.body));
  assert.equal(body.author, "urn:li:person:y");
  assert.equal(body.commentary, "adopt \\(a\\) SDK");
  assert.equal(body.lifecycleState, "PUBLISHED");
});

test("a rejected publish surfaces LinkedIn's status and message", async () => {
  await assert.rejects(
    () => publishTextPost("text", async () => new Response("Requested version 202601 is not active", { status: 426 }), store(Date.now() + day)),
    /LinkedIn rejected the post \(426\): Requested version 202601 is not active/,
  );
});

test("falls back to the previous API version when LinkedIn answers 426", async () => {
  const versions: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const version = (init?.headers as Record<string, string>)["Linkedin-Version"]!;
    versions.push(version);
    return version === linkedInApiVersions[0]
      ? new Response('{"code":"NONEXISTENT_VERSION"}', { status: 426 })
      : new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:9" } });
  };
  assert.equal(await publishTextPost("text", fetcher, store(Date.now() + day)), "urn:li:share:9");
  assert.deepEqual(versions, [...linkedInApiVersions]);
});

test("a publish is only called rejected when LinkedIn cannot have the post", async () => {
  const outcome = async (fetcher: typeof fetch, expiresAt = Date.now() + day) =>
    publishTextPost("text", fetcher, store(expiresAt)).then(() => "published", (error: LinkedInPublishError) => error.outcome);
  const answer = (status: number) => async () => new Response("x", { status });
  assert.equal(await outcome(answer(422)), "rejected");
  assert.equal(await outcome(answer(429)), "rejected");
  assert.equal(await outcome(answer(502)), "rejected");
  assert.equal(await outcome(answer(503)), "rejected");
  assert.equal(await outcome(answer(500)), "unknown");
  assert.equal(await outcome(answer(504)), "unknown");
  assert.equal(await outcome(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }), "unknown");
  assert.equal(await outcome(async () => { throw new Error("must not be called"); }, Date.now() - day), "rejected", "an expired token sends nothing");
});

test("the publish call gives up before the publish route is killed", async () => {
  let signal: AbortSignal | null | undefined;
  await publishTextPost("text", async (_input, init) => { signal = init?.signal; return new Response("", { status: 201 }); }, store(Date.now() + day));
  assert.ok(signal instanceof AbortSignal);
});

test("an authorization this version cannot read says how to replace it", async () => {
  const unreadable = { get: async <T,>() => ({ accessToken: "x", memberId: "y", expiresAt: "soon" }) as T };
  await assert.rejects(() => linkedInTokenStatus(now, unreadable), /cannot read[\s\S]*reconnect LinkedIn/);
});
