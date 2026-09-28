import test from "node:test";
import assert from "node:assert/strict";
import { envValue, required } from "../src/lib/env";

test("a value is read without surrounding whitespace", () => {
  assert.equal(envValue("NTFY_TOPIC", { NTFY_TOPIC: "  topic\r\n" }), "topic");
});

test("a blank or whitespace-only value counts as unset", () => {
  assert.equal(envValue("NTFY_TOPIC", { NTFY_TOPIC: "" }), undefined);
  assert.equal(envValue("NTFY_TOPIC", { NTFY_TOPIC: " \t" }), undefined);
  assert.equal(envValue("NTFY_TOPIC", {}), undefined);
});

test("a required variable left blank is reported as missing, by name", (t) => {
  process.env.GROQ_API_KEY = " ";
  t.after(() => { delete process.env.GROQ_API_KEY; });
  assert.throws(() => required("GROQ_API_KEY"), /Missing required environment variable: GROQ_API_KEY/);
});
