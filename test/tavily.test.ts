import test from "node:test";
import assert from "node:assert/strict";
import { searchThemeEvidence } from "../src/lib/research/tavily";
import { themeDefinition } from "../src/lib/research/themes";
import { config } from "../src/lib/config";

process.env.TAVILY_API_KEY = "test-key";

const result = {
  title: "A release", url: "https://openai.com/index/release",
  content: "Developer details", published_date: "2026-07-12T09:30:00Z",
};

test("keeps only web pages, since every source URL becomes a link", async () => {
  const results = await searchThemeEvidence("ai-integration", new Date("2026-07-14T12:00:00Z"), async () => Response.json({
    results: [result, { ...result, url: "javascript:alert(1)" }, { ...result, url: "data:text/html,hi" }],
  }));
  assert.deepEqual([...new Set(results.map((entry) => entry.url))], [result.url]);
});

test("requests bounded, recent Tavily news evidence", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const results = await searchThemeEvidence(
    "ai-integration",
    new Date("2026-07-14T12:00:00Z"),
    async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ results: [{ ...result, url: "https://example.com/release" }] });
    },
  );
  const body = bodies[0]!;
  assert.equal(body.search_depth, "advanced");
  assert.equal(body.chunks_per_source, 2);
  assert.equal(body.topic, "news");
  assert.match(String(body.query), /LLM API structured outputs/);
  assert.equal(body.max_results, 10);
  assert.equal(body.start_date, "2026-06-30");
  assert.equal(body.end_date, "2026-07-15");
  assert.equal(results[0]!.publishedDate, "2026-07-12");
});

test("runs every query of the theme and merges the results by URL", async () => {
  const queries: string[] = [];
  const results = await searchThemeEvidence("frontend", new Date("2026-07-14T12:00:00Z"), async (_input, init) => {
    queries.push(String(JSON.parse(String(init?.body)).query));
    return Response.json({ results: [result, { ...result, url: "https://openai.com/index/release/" }] });
  });
  assert.deepEqual(queries, themeDefinition("frontend").queries);
  assert.equal(results.length, 1, "the same article from two queries is one result");
});

test("keeps dates out of the query text", async () => {
  let query = "";
  await searchThemeEvidence("frontend", new Date("2026-07-14T12:00:00Z"), async (_input, init) => {
    query = String(JSON.parse(String(init?.body)).query);
    return Response.json({ results: [result] });
  });
  assert.doesNotMatch(query, /published near/);
});

test("searches the evidence-bar domains before searching openly", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  await searchThemeEvidence("ai-integration", new Date("2026-07-14T12:00:00Z"), async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ results: [result] });
  });
  assert.equal(bodies.length, themeDefinition("ai-integration").queries.length, "a productive restricted pass must not trigger the open pass");
  const domains = bodies[0]!.include_domains as string[];
  assert.ok(domains.includes("openai.com"));
  assert.ok(domains.includes("infoq.com"));
  assert.ok(!domains.includes("aimultiple.com"));
});

test("falls back to an open search when the restricted one finds nothing", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const results = await searchThemeEvidence("ai-integration", new Date("2026-07-14T12:00:00Z"), async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if ("include_domains" in body) return Response.json({ results: [] });
    return Response.json({ results: [{ ...result, url: "https://aimultiple.com/round-up" }] });
  });
  const restricted = bodies.filter((body) => "include_domains" in body);
  const open = bodies.filter((body) => !("include_domains" in body));
  assert.deepEqual(restricted.map((body) => body.topic), ["news", "news", "general", "general"]);
  assert.deepEqual(open.map((body) => body.topic), ["news", "news"]);
  assert.equal(results.length, 1, "the open search still returns; the evidence bar judges it later");
});

test("falls back to an open search when the restricted one is rejected", async () => {
  let restrictedCalls = 0;
  const results = await searchThemeEvidence("ai-integration", new Date("2026-07-14T12:00:00Z"), async (_input, init) => {
    if ("include_domains" in JSON.parse(String(init?.body))) {
      restrictedCalls += 1;
      return new Response("unsupported parameter", { status: 400 });
    }
    return Response.json({ results: [result] });
  });
  assert.ok(restrictedCalls >= 1);
  assert.equal(results.length, 1);
});

test("surfaces a genuine Tavily outage rather than swallowing it", async () => {
  await assert.rejects(
    () => searchThemeEvidence("ai-integration", new Date("2026-07-14T12:00:00Z"), async () =>
      new Response("upstream down", { status: 503 })),
    /Tavily search failed \(503\)/,
  );
});

test("drops undated or invalid Tavily results", async () => {
  const results = await searchThemeEvidence(
    "ai-integration",
    new Date("2026-07-14T12:00:00Z"),
    async () => Response.json({ results: [
      { title: "No date", url: "https://example.com/a", content: "A" },
      { title: "Bad URL", url: "not-a-url", content: "B", published_date: "2026-07-12" },
    ] }),
  );
  assert.deepEqual(results, []);
});

test("the web stack's own release channels count as first-party evidence", async () => {
  let domains: string[] = [];
  await searchThemeEvidence("ai-integration", new Date("2026-07-14T12:00:00Z"), async (_input, init) => {
    domains = JSON.parse(String(init?.body)).include_domains as string[];
    return Response.json({ results: [{ ...result, url: "https://nextjs.org/blog/next-16" }] });
  });
  for (const domain of ["react.dev", "nextjs.org", "nodejs.org", "vitest.dev", "prisma.io", "vite.dev", "neon.com"]) {
    assert.ok(domains.includes(domain), domain);
  }
  assert.ok(!domains.includes("nvidia.com"), "GPU vendors only feed the banned scale");
});

test("asks the general index for the allowlisted domains when the news index has nothing first-party", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const results = await searchThemeEvidence("frontend", new Date("2026-07-14T12:00:00Z"), async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (body.topic === "news") return Response.json({ results: [{ ...result, url: "https://aimultiple.com/round-up" }] });
    return Response.json({ results: [{ ...result, url: "https://nextjs.org/blog/next-16-3" }] });
  });
  assert.deepEqual(bodies.map((body) => `${body.topic}:${"include_domains" in body ? "allowlist" : "open"}`),
    ["news:allowlist", "news:allowlist", "general:allowlist", "general:allowlist"]);
  assert.deepEqual(results.map((entry) => entry.url).sort(), ["https://aimultiple.com/round-up", "https://nextjs.org/blog/next-16-3"]);
});

test("every search can be abandoned when Tavily hangs", async () => {
  const signals: unknown[] = [];
  await searchThemeEvidence("frontend", new Date("2026-07-14T12:00:00Z"), async (_input, init) => {
    signals.push(init?.signal);
    return Response.json({ results: [] });
  });
  assert.ok(signals.length > 0 && signals.every((signal) => signal instanceof AbortSignal));
});

test("the search window is the source window it is given", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  await searchThemeEvidence("ai-integration", new Date("2026-07-14T12:00:00Z"), async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ results: [] });
  }, { ...config(), limits: { ...config().limits, sourceWindowDays: 3 } });
  assert.ok(bodies.length > 0);
  for (const body of bodies) assert.equal(body.start_date, "2026-07-11");
});
