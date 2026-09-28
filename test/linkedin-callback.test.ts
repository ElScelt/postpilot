import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { handleLinkedInCallback, type CallbackDeps } from "../src/app/api/auth/linkedin/callback/handler";
import { signedState } from "../src/lib/linkedin/oauth";
import type { TokenRecord } from "../src/lib/linkedin/token";

process.env.LINKEDIN_STATE_SECRET = "state-secret";
process.env.LINKEDIN_REDIRECT_URI = "https://example.vercel.app/api/auth/linkedin/callback";
process.env.LINKEDIN_CLIENT_ID = "client";
process.env.LINKEDIN_CLIENT_SECRET = "client-secret";

type Options = { member?: string; stored?: TokenRecord; exchange?: Response };

// LinkedIn's token and profile endpoints, and the token store, in memory.
function fakes(options: Options = {}) {
  const saved: TokenRecord[] = [];
  const deps: CallbackDeps = {
    fetcher: async (input) => String(input).includes("accessToken")
      ? options.exchange ?? Response.json({ access_token: "new-token", expires_in: 60 * 86_400 })
      : Response.json({ sub: options.member ?? "owner" }),
    loadLinkedInToken: async () => options.stored ?? null,
    saveLinkedInToken: async (token) => { saved.push(token); },
  };
  return { deps, saved };
}

function callback(state = signedState(), cookie = state) {
  return new NextRequest(`https://example.vercel.app/api/auth/linkedin/callback?code=abc&state=${state}`, {
    headers: { cookie: `postpilot_oauth_state=${cookie}` },
  });
}

test("a callback whose state is forged or does not match the cookie is refused", async () => {
  const { deps, saved } = fakes();
  assert.equal((await handleLinkedInCallback(callback("forged.state", "forged.state"), deps)).status, 400);
  assert.equal((await handleLinkedInCallback(callback(signedState(), signedState()), deps)).status, 400);
  assert.deepEqual(saved, []);
});

test("a failed token exchange is reported and saves nothing", async () => {
  const { deps, saved } = fakes({ exchange: new Response("invalid_grant", { status: 400 }) });
  const response = await handleLinkedInCallback(callback(), deps);
  assert.equal(response.status, 502);
  assert.match(await response.text(), /invalid_grant/);
  assert.deepEqual(saved, []);
});

test("the first member to connect binds the deployment, and the state cookie is cleared", async () => {
  const { deps, saved } = fakes({ member: "owner" });
  const response = await handleLinkedInCallback(callback(), deps);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /connected as member owner/);
  assert.equal(saved[0]!.memberId, "owner");
  assert.equal(saved[0]!.accessToken, "new-token");
  assert.match(response.headers.get("set-cookie") ?? "", /postpilot_oauth_state=;/);
});

test("once bound, another member cannot take over the deployment", async () => {
  const stored = { accessToken: "old", memberId: "owner", expiresAt: Date.now() + 86_400_000 };
  const { deps, saved } = fakes({ member: "intruder", stored });
  const response = await handleLinkedInCallback(callback(), deps);
  assert.equal(response.status, 403);
  assert.deepEqual(saved, []);
  const owner = fakes({ member: "owner", stored });
  assert.equal((await handleLinkedInCallback(callback(), owner.deps)).status, 200, "the owner can reconnect");
});

test("LINKEDIN_MEMBER_ID decides the owner even when nobody has connected yet", async (t) => {
  process.env.LINKEDIN_MEMBER_ID = "configured";
  t.after(() => { delete process.env.LINKEDIN_MEMBER_ID; });
  const { deps, saved } = fakes({ member: "first-comer" });
  assert.equal((await handleLinkedInCallback(callback(), deps)).status, 403);
  assert.deepEqual(saved, []);
});
