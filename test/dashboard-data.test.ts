import test from "node:test";
import assert from "node:assert/strict";
import { loadDashboard, type DashboardDeps } from "../src/app/dashboard/data";
import { tokenSummary } from "../src/lib/linkedin/api";
import { requiredVariables } from "../src/lib/env";
import type { QueuedPost } from "../src/lib/storage/posts";
import type { AutomationRun } from "../src/lib/storage/runs";

const now = new Date("2026-09-28T12:00:00Z");
const env = { ...Object.fromEntries(requiredVariables.map((name) => [name, "x"])), APP_URL: "https://example.vercel.app", LINKEDIN_REDIRECT_URI: "https://example.vercel.app/api/auth/linkedin/callback", KV_REST_API_URL: "https://redis", KV_REST_API_TOKEN: "t", NTFY_TOPIC: "t", HEALTHCHECK_URL: "https://hc" };

function post(id: string, scheduledFor: string): QueuedPost {
  return { id, text: "Text.", scheduledFor, status: "posted", createdAt: scheduledFor };
}

function deps(overrides: Partial<DashboardDeps> = {}): Partial<DashboardDeps> {
  return {
    linkedInTokenStatus: async () => ({ state: "valid", daysRemaining: 30 }),
    loadLinkedInToken: async () => ({ accessToken: "a", memberId: "member", expiresAt: 0 }),
    listPosts: async () => [],
    listAutomationRuns: async () => [],
    describeLiveSchedule: async () => ({ id: "postpilot-run", cron: "0 18 * * 1,3,5", live: undefined }),
    env: { ...env, LINKEDIN_MEMBER_ID: "member" },
    ...overrides,
  };
}

test("the authorization line says how urgently to reconnect", () => {
  assert.deepEqual(tokenSummary({ state: "missing" }), { tone: "bad", text: "LinkedIn is not connected." });
  assert.deepEqual(tokenSummary({ state: "expired", daysRemaining: -3 }), { tone: "bad", text: "LinkedIn authorization expired 3 days ago." });
  assert.deepEqual(tokenSummary({ state: "valid", daysRemaining: 10 }), { tone: "warn", text: "LinkedIn authorization expires in 10 days." });
  assert.deepEqual(tokenSummary({ state: "valid", daysRemaining: 11 }), { tone: "ok", text: "LinkedIn authorization valid for 11 more days." });
});

test("a healthy deployment loads with nothing to fix", async () => {
  const dashboard = await loadDashboard(now, "example.vercel.app", deps());
  assert.equal(dashboard.setupOk, true);
  assert.deepEqual(dashboard.setup, []);
  assert.deepEqual(dashboard.token, { state: "valid", daysRemaining: 30 });
});

test("an unreachable Redis or QStash becomes a setup line, and the rest still loads", async () => {
  const runs: AutomationRun[] = [{ ranAt: "2026-09-27T18:00:00Z", status: "scheduled" }];
  const dashboard = await loadDashboard(now, "example.vercel.app", deps({
    listPosts: async () => { throw new Error("fetch failed"); },
    listAutomationRuns: async () => runs,
    describeLiveSchedule: async () => { throw new Error("Unauthorized"); },
  }));
  assert.equal(dashboard.setupOk, false);
  assert.deepEqual(dashboard.setup.slice(0, 2), [
    { level: "error", text: "Redis: fetch failed" },
    { level: "error", text: "QStash: Unauthorized" },
  ]);
  assert.deepEqual(dashboard.posts, []);
  assert.deepEqual(dashboard.runs, runs);
  assert.equal(dashboard.schedule, undefined);
});

test("posts and runs are shown newest first, twenty of each", async () => {
  const posts = Array.from({ length: 25 }, (_, day) => post(`p${day}`, new Date(Date.UTC(2026, 7, day + 1, 6)).toISOString()));
  const runs = Array.from({ length: 25 }, (_, day): AutomationRun => ({ ranAt: new Date(Date.UTC(2026, 7, day + 1, 18)).toISOString(), status: "skipped" }));
  const dashboard = await loadDashboard(now, "example.vercel.app", deps({ listPosts: async () => posts, listAutomationRuns: async () => runs }));
  assert.equal(dashboard.posts.length, 20);
  assert.equal(dashboard.posts[0]!.id, "p24");
  assert.equal(dashboard.runs.length, 20);
  assert.equal(dashboard.runs[0]!.ranAt, runs[24]!.ranAt);
});

test("the connected member is compared with LINKEDIN_MEMBER_ID", async () => {
  const dashboard = await loadDashboard(now, "example.vercel.app", deps({ env: { ...env, LINKEDIN_MEMBER_ID: "someone-else" } }));
  assert.equal(dashboard.setupOk, false);
  assert.match(dashboard.setup.map((check) => check.text).join("\n"), /LINKEDIN_MEMBER_ID is someone-else but the connected member is member/);
});
