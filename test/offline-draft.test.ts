import test from "node:test";
import assert from "node:assert/strict";
import { generateGroundedDraft } from "../src/lib/drafting/pipeline";
import { themeIds } from "../src/lib/research/themes";
import { createOfflineFetch, setOfflineCredentials } from "../scripts/offline";

test("the offline draft clears the validator and review on every default theme", async () => {
  setOfflineCredentials();
  const now = new Date("2026-09-06T18:00:00.000Z");
  for (const theme of themeIds()) {
    const recent = { posts: [], topics: [], sourceUrls: [], themes: themeIds().filter((other) => other !== theme) };
    const outcome = await generateGroundedDraft(recent, now, createOfflineFetch(now));
    assert.equal(outcome.theme, theme);
    assert.equal(outcome.decision.shouldPost, true, theme);
    assert.deepEqual(outcome.attempts, [], theme);
    assert.deepEqual(outcome.notes, [], theme);
  }
});

test("offline mode refuses requests it has no canned answer for", async () => {
  await assert.rejects(createOfflineFetch()("https://example.com/"), /no canned answer/);
});
