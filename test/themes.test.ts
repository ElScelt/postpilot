import test from "node:test";
import assert from "node:assert/strict";
import { isPostTheme, themeIds, themeDefinition, themeOrder } from "../src/lib/research/themes";

test("every theme has natural search queries and a brief for the prompt", () => {
  for (const theme of themeIds()) {
    assert.ok(themeDefinition(theme).queries.length >= 2, theme);
    for (const query of themeDefinition(theme).queries) {
      assert.ok(query.length > 10 && query.length < 400, query);
      assert.doesNotMatch(query, /published near/);
    }
    assert.ok(themeDefinition(theme).brief.length > 10, theme);
  }
  assert.ok(isPostTheme("frontend"));
  assert.ok(!isPostTheme("hardware"));
});

test("puts the least recently used theme first", () => {
  const order = themeOrder(["frontend", "data", "backend", "frontend"], new Date("2026-09-02T18:00:00Z"));
  // Never-used themes lead, then data (oldest use), then backend, then frontend last.
  assert.deepEqual(order.slice(-3), ["data", "backend", "frontend"]);
  assert.deepEqual(new Set(order.slice(0, 3)), new Set(["ai-integration", "testing", "platform"]));
  assert.equal(order.length, themeIds().length);
});

test("cycles through every theme over consecutive runs", () => {
  const used: string[] = [];
  for (let day = 0; day < themeIds().length; day += 1) {
    used.push(themeOrder(used, new Date(Date.UTC(2026, 8, 6 + day * 2)))[0]!);
  }
  assert.deepEqual(new Set(used), new Set(themeIds()));
});

test("never-used themes are ordered by the calendar so restarts do not pin one theme", () => {
  const monday = themeOrder([], new Date("2026-09-07T18:00:00Z"))[0];
  const wednesday = themeOrder([], new Date("2026-09-09T18:00:00Z"))[0];
  assert.notEqual(monday, wednesday);
});
