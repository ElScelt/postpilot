// What postpilot does when postpilot.config.ts leaves a field out. The themes suit a
// developer who ships web products; replace them with the subjects you write about.

export const defaultPersona = {
  role: "working software developer who builds products for a living",
  scale: "one developer on a small product team, shipping and maintaining software that real users depend on",
  // Decisions that are somebody else's job at that scale. Each term also matches its
  // plural and suffixed forms ("GPUs", "on-premises"), and a space or hyphen inside a
  // term matches either or neither ("data-center", "datacenter").
  avoidTopics: [
    "on-prem", "Kubernetes", "k8s", "GPU", "DGX", "data center", "data centre", "accelerator",
    "inference cluster", "inference node", "tokens per second", "tok/s", "tokens/s",
  ],
};

// Rotating the research query through subject areas is what stops every post from being
// a model launch, which is what a single "AI developer tools" query returns nightly. Two
// natural search queries per theme: one for what vendors changed, one for what
// practitioners learned.
export const defaultThemes = {
  "frontend": {
    label: "Frontend",
    queries: [
      "Next.js or React release notes breaking changes migration guide",
      "new browser API shipped in Chrome Safari Firefox for web developers",
    ],
    brief: "React, Next.js, browser APIs, rendering, forms, streaming UI, and what a release changes in the components you ship.",
  },
  "backend": {
    label: "Backend",
    queries: [
      "Node.js TypeScript Bun or Deno release notes deprecations breaking changes",
      "API server framework release Hono Fastify NestJS Express developers",
    ],
    brief: "Node.js, TypeScript, runtimes, route handlers, background jobs, and API design in a web service.",
  },
  "ai-integration": {
    label: "AI inside web apps",
    queries: [
      "LLM API structured outputs tool calling streaming change for app developers",
      "AI SDK release or model API pricing change per token",
    ],
    brief: "Wiring an LLM into a product: streaming responses into the UI, tool calling from a route handler, prompt versioning, cost per user, failure handling.",
  },
  "testing": {
    label: "Testing and CI",
    queries: [
      "Vitest Playwright or Jest release notes breaking changes",
      "flaky end-to-end tests CI pipeline engineering lessons",
    ],
    brief: "Unit and end-to-end testing, CI pipelines, flaky tests, testing prompts and AI features, type checking and linting.",
  },
  "data": {
    label: "Data and storage",
    queries: [
      "Postgres Prisma or Drizzle release notes migrations",
      "Neon Turso Supabase or Redis database pricing or feature change",
    ],
    brief: "Databases, ORMs, migrations, caching, vector search inside an existing product database, and data modeling for web apps.",
  },
  "platform": {
    label: "Deploy and platform",
    queries: [
      "Vercel Cloudflare Workers or Netlify pricing change developers",
      "serverless edge runtime or auth provider release notes Clerk Auth0",
    ],
    brief: "Deploying web apps, edge and serverless runtimes, auth, observability, and platform pricing as it lands on a small team's bill.",
  },
};
