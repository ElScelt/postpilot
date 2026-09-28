import test from "node:test";
import assert from "node:assert/strict";
import { draftMessage, notifyDraftQueued, notifyOperator, ntfyRequest, sendNtfy, rejectUrl } from "../src/lib/notify/ntfy";
import { validRejectToken, rejectToken } from "../src/lib/security/reject-token";

process.env.AUTOMATION_SECRET = "test-secret";

const notice = {
  postId: "abc-123",
  text: "A draft that publishes tomorrow.",
  scheduledFor: "2026-07-30T06:00:00.000Z",
  topic: "secret-topic",
  appUrl: "https://example.vercel.app/",
};

const noWait = async () => undefined;

test("the reject link carries a signature for its own post", () => {
  const url = new URL(rejectUrl(notice));
  assert.equal(url.pathname, "/api/posts/reject");
  assert.equal(url.searchParams.get("id"), "abc-123");
  assert.ok(validRejectToken("abc-123", url.searchParams.get("token")));
});

test("a token for one post does not reject another", () => {
  assert.equal(validRejectToken("different-post", rejectToken("abc-123")), false);
});

test("a missing or malformed token is refused", () => {
  assert.equal(validRejectToken("abc-123", null), false);
  assert.equal(validRejectToken("abc-123", "short"), false);
});

test("the notification offers a one-tap reject, a page to read, and opens that page on tap", () => {
  const { url, init } = ntfyRequest(draftMessage(notice));
  assert.equal(url, "https://ntfy.sh/secret-topic");
  const headers = init.headers as Record<string, string>;
  assert.match(headers.Actions!, /^http, Reject, https:\/\/example\.vercel\.app\/api\/posts\/reject\?/);
  assert.match(headers.Actions!, /view, Read and decide/);
  assert.equal(headers.Click, rejectUrl(notice));
  assert.equal(init.body, notice.text);
});

test("the title states the publish time in the configured time zone", () => {
  const { init } = ntfyRequest(draftMessage(notice));
  assert.match((init.headers as Record<string, string>).Title!, /06:00/);
});

test("a failed notification never throws at the caller", async () => {
  const failed = await notifyDraftQueued(notice, async () => new Response("nope", { status: 400 }));
  assert.equal(failed, false);
});

test("a delivered notification reports success", async () => {
  assert.equal(await notifyDraftQueued(notice, async () => new Response("ok")), true);
});

test("retries a transient ntfy failure before giving up", async () => {
  let calls = 0;
  const waits: number[] = [];
  const delivered = await sendNtfy({ topic: "t", title: "x", body: "y" }, async () => {
    calls += 1;
    return calls < 3 ? new Response("busy", { status: 503 }) : new Response("ok");
  }, async (milliseconds) => { waits.push(milliseconds); });
  assert.equal(delivered, true);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 3000]);
});

test("gives up after the retries are spent, including on a network error", async () => {
  let calls = 0;
  const delivered = await sendNtfy({ topic: "t", title: "x", body: "y" }, async () => {
    calls += 1;
    throw new Error("offline");
  }, noWait);
  assert.equal(delivered, false);
  assert.equal(calls, 3);
});

test("operator alerts carry a high priority and open their link", async () => {
  let captured: RequestInit | undefined;
  const delivered = await notifyOperator(
    { title: "Reconnect LinkedIn", body: "It expires tonight.", priority: 5, link: "https://example.vercel.app/api/auth/linkedin" },
    "secret-topic",
    async (_input, init) => { captured = init; return new Response("ok"); },
  );
  assert.equal(delivered, true);
  const headers = captured?.headers as Record<string, string>;
  assert.equal(headers.Priority, "5");
  assert.equal(headers.Click, "https://example.vercel.app/api/auth/linkedin");
  assert.match(headers.Actions!, /^view, Open, https:\/\/example\.vercel\.app\/api\/auth\/linkedin$/);
});

test("operator alerts are silently skipped without a topic", async () => {
  assert.equal(await notifyOperator({ title: "x", body: "y" }, undefined, async () => { throw new Error("must not be called"); }), false);
});

test("a self-hosted server and an access token are honoured when configured", (t) => {
  process.env.NTFY_URL = "https://ntfy.example.com/";
  process.env.NTFY_TOKEN = "tk_abc";
  t.after(() => { delete process.env.NTFY_URL; delete process.env.NTFY_TOKEN; });
  const { url, init } = ntfyRequest(draftMessage(notice));
  assert.equal(url, "https://ntfy.example.com/secret-topic");
  assert.equal((init.headers as Record<string, string>).Authorization, "Bearer tk_abc");
});

test("a server or token left blank falls back to ntfy.sh without a token", (t) => {
  process.env.NTFY_URL = "";
  process.env.NTFY_TOKEN = " \r";
  t.after(() => { delete process.env.NTFY_URL; delete process.env.NTFY_TOKEN; });
  const { url, init } = ntfyRequest(draftMessage(notice));
  assert.equal(url, "https://ntfy.sh/secret-topic");
  assert.equal((init.headers as Record<string, string>).Authorization, undefined);
});

test("a hung ntfy request is abandoned rather than holding the run", async () => {
  let signal: AbortSignal | null | undefined;
  await sendNtfy({ topic: "t", title: "x", body: "y" }, async (_input, init) => { signal = init?.signal; return new Response("ok"); });
  assert.ok(signal instanceof AbortSignal);
});
