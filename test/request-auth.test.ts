import assert from "node:assert/strict";
import test from "node:test";
import { authorizeQStashRequest, authorizeRunRequest, isQStashSigned } from "../src/lib/security/request-auth";

const body = "{}";

test("accepts the configured bearer secret for manual runs", async () => {
  process.env.AUTOMATION_SECRET = "current-secret";
  const request = new Request("https://example.com/api/automation/run", {
    headers: { authorization: "Bearer current-secret" },
  });

  assert.equal(await authorizeRunRequest(request, body), true);
  assert.equal(isQStashSigned(request), false);
});

test("rejects a wrong bearer secret", async () => {
  process.env.AUTOMATION_SECRET = "current-secret";
  for (const header of ["Bearer current-secreT", "Bearer current", "current-secret"]) {
    const request = new Request("https://example.com/api/automation/run", { headers: { authorization: header } });
    assert.equal(await authorizeRunRequest(request, body), false, header);
  }
});

test("prefers a valid QStash signature over a stale bearer secret", async () => {
  process.env.AUTOMATION_SECRET = "current-secret";
  const request = new Request("https://example.com/api/automation/run", {
    headers: {
      authorization: "Bearer stale-secret",
      "upstash-signature": "signed-message",
    },
  });

  const authorized = await authorizeRunRequest(request, body, async () => true);
  assert.equal(authorized, true);
  assert.equal(isQStashSigned(request), true);
});

test("rejects an invalid QStash signature", async () => {
  const request = new Request("https://example.com/api/automation/run", {
    headers: { "upstash-signature": "invalid" },
  });

  const authorized = await authorizeRunRequest(request, body, async () => false);
  assert.equal(authorized, false);
});

test("a verifier that throws is treated as unauthorized", async () => {
  const request = new Request("https://example.com/api/automation/run", {
    headers: { "upstash-signature": "invalid" },
  });
  assert.equal(await authorizeRunRequest(request, body, async () => { throw new Error("bad key"); }), false);
});

test("rejects a bearer header when no automation secret is configured", async (t) => {
  const saved = process.env.AUTOMATION_SECRET;
  delete process.env.AUTOMATION_SECRET;
  t.after(() => { process.env.AUTOMATION_SECRET = saved; });
  const request = new Request("https://example.com/api/automation/run", {
    headers: { authorization: "Bearer undefined" },
  });
  assert.equal(await authorizeRunRequest(request, body), false);
});

test("requires a QStash signature for publishing", async () => {
  const request = new Request("https://example.com/api/cron/publish", {
    headers: { Authorization: "Bearer no-longer-used" },
  });

  assert.equal(await authorizeQStashRequest(request, "{}", async () => true), false);
});

test("accepts a valid QStash signature for publishing", async () => {
  const request = new Request("https://example.com/api/cron/publish", {
    headers: { "Upstash-Signature": "valid-signature" },
  });

  assert.equal(await authorizeQStashRequest(request, "{}", async () => true), true);
});
