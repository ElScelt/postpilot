import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, userConfigFile } from "../src/lib/config";

// The rest of the suite runs on the defaults (test/setup.ts); this is the check that
// your own postpilot.config.ts is valid.
test("postpilot.config.ts is valid", () => {
  assert.doesNotThrow(() => loadConfig(userConfigFile()));
});

test("an empty configuration falls back to every default", () => {
  const settings = loadConfig({});
  assert.equal(settings.timeZone, "UTC");
  assert.equal(settings.publishHour, 9);
  assert.deepEqual(settings.schedule, { days: ["sun", "tue", "thu"], runHour: 21 });
  assert.deepEqual(settings.limits, { minWords: 140, maxWords: 220, maxHookLength: 160, sourceWindowDays: 14 });
  assert.match(settings.persona.role, /software developer/);
  assert.deepEqual(settings.persona.stack, []);
  assert.equal(settings.persona.voice, "");
  assert.deepEqual(Object.keys(settings.themes), ["frontend", "backend", "ai-integration", "testing", "data", "platform"]);
  assert.deepEqual(settings.evidence, { primaryDomains: [], credibleDomains: [] });
});

test("a partial section keeps the defaults for the fields it leaves out", () => {
  const settings = loadConfig({ persona: { stack: ["Go"] }, limits: { maxWords: 250 } });
  assert.deepEqual(settings.persona.stack, ["Go"]);
  assert.match(settings.persona.role, /software developer/);
  assert.equal(settings.limits.maxWords, 250);
  assert.equal(settings.limits.minWords, 140);
});

test("custom themes replace the defaults", () => {
  const settings = loadConfig({ themes: { rust: { label: "Rust", queries: ["Rust release notes"], brief: "Rust in production." } } });
  assert.deepEqual(Object.keys(settings.themes), ["rust"]);
});

test("a mistake names the field that is wrong", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ timeZone: "Mars/Olympus" }, /timeZone/],
    [{ publishHour: 25 }, /publishHour/],
    [{ schedule: { days: ["monday"] } }, /schedule\.days/],
    [{ schedule: { days: [] } }, /schedule\.days/],
    [{ limits: { minWords: 300 } }, /minWords must be below maxWords/],
    [{ themes: {} }, /at least one theme/],
    [{ themes: { "Not A Slug": { label: "x", queries: ["q"], brief: "b" } } }, /theme ids are lowercase words joined by hyphens/],
    [{ timezone: "UTC" }, /Unrecognized key/],
    [{ evidence: { primaryDomains: ["https://go.dev"] } }, /evidence\.primaryDomains/],
    [{ evidence: { domains: ["go.dev"] } }, /Unrecognized key/],
  ];
  for (const [input, message] of cases) {
    assert.throws(() => loadConfig(input), message, JSON.stringify(input));
  }
});
