import test from "node:test";
import assert from "node:assert/strict";
import { signedState, validState } from "../src/lib/linkedin/oauth";

process.env.LINKEDIN_STATE_SECRET = "state-secret";

test("a freshly signed state round-trips", () => {
  assert.equal(validState(signedState()), true);
});

test("a tampered signature is refused", () => {
  const state = signedState();
  const flipped = state.slice(0, -1) + (state.endsWith("0") ? "1" : "0");
  assert.equal(validState(flipped), false);
});

test("a state signed under another secret is refused", () => {
  const state = signedState();
  process.env.LINKEDIN_STATE_SECRET = "rotated";
  assert.equal(validState(state), false);
  process.env.LINKEDIN_STATE_SECRET = "state-secret";
});

test("missing or malformed states are refused", () => {
  assert.equal(validState(null), false);
  assert.equal(validState("nonce-only"), false);
  assert.equal(validState("."), false);
});
