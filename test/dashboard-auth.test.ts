import test from "node:test";
import assert from "node:assert/strict";
import { authorizeDashboard } from "../src/lib/security/dashboard-auth";

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

test("accepts the automation secret as the Basic auth password, whatever the username", () => {
  assert.equal(authorizeDashboard(basic("me", "s3cret"), "s3cret"), true);
  assert.equal(authorizeDashboard(basic("", "s3cret"), "s3cret"), true);
});

test("refuses a wrong, missing or malformed credential", () => {
  assert.equal(authorizeDashboard(basic("me", "wrong"), "s3cret"), false);
  assert.equal(authorizeDashboard(basic("me", "s3cre"), "s3cret"), false);
  assert.equal(authorizeDashboard(null, "s3cret"), false);
  assert.equal(authorizeDashboard("Bearer s3cret", "s3cret"), false);
  assert.equal(authorizeDashboard("Basic not-base64!!", "s3cret"), false);
});

test("refuses everything when no secret is configured", () => {
  assert.equal(authorizeDashboard(basic("me", ""), undefined), false);
  assert.equal(authorizeDashboard(basic("me", ""), ""), false);
});
