export type SourceTier = "primary" | "credible" | "reference" | "unrated";

// First-party announcements and research: the vendor or lab making the claim. Hosts
// where anyone can publish (github.com repositories, huggingface.co model cards,
// arxiv.org preprints) are deliberately absent: a stranger's README must never stand in
// for a vendor announcement on its own, so they count as credible and need a second
// publisher.
const primaryDomains = [
  "openai.com", "anthropic.com", "ai.google.dev", "developers.googleblog.com",
  "github.blog", "microsoft.com", "research.google", "meta.com",
  "aws.amazon.com", "cloudflare.com",
  "vercel.com", "cursor.com", "mistral.ai", "cohere.com",
  "groq.com", "deepmind.google", "blog.google", "modelcontextprotocol.io",
  // The web stack itself: framework, runtime, tooling, and database vendors whose
  // release notes are the first-party source for the non-AI themes.
  "react.dev", "nextjs.org", "nodejs.org", "typescriptlang.org", "bun.sh", "deno.com",
  "vitest.dev", "playwright.dev", "prisma.io", "drizzle.team", "supabase.com",
  "postgresql.org", "web.dev", "developer.chrome.com", "tanstack.com", "astro.build",
  "vite.dev", "tailwindcss.com", "developer.mozilla.org", "webkit.org", "hacks.mozilla.org",
  "hono.dev", "fastify.dev", "biomejs.dev", "eslint.org", "cypress.io", "neon.com",
  "turso.tech", "redis.io", "upstash.com", "sqlite.org", "sentry.io", "clerk.com",
  "netlify.com", "fly.io", "ai-sdk.dev",
];

// Established press with editorial standards. Anything absent from both lists is
// unrated and counts toward nothing — that is what keeps SEO listicles, PR-newswire
// republishes, and open publishing platforms out of the evidence base.
const credibleDomains = [
  "reuters.com", "apnews.com", "bloomberg.com", "wsj.com", "ft.com",
  "cnbc.com", "forbes.com", "techcrunch.com", "theverge.com", "arstechnica.com",
  "wired.com", "technologyreview.com", "spectrum.ieee.org", "nature.com",
  "science.org", "infoq.com", "securityweek.com", "theregister.com",
  "zdnet.com", "venturebeat.com", "thenewstack.io", "infoworld.com",
  "computerworld.com", "theinformation.com",
  "github.com", "huggingface.co", "arxiv.org",
];

// Every domain that can contribute to the evidence bar. Searching these first keeps
// the research aligned with the standard the draft is later judged against.
export const evidenceDomains = [...primaryDomains, ...credibleDomains];

function matchedDomain(host: string, domains: string[]) {
  return domains.find((domain) => host === domain || host.endsWith(`.${domain}`));
}

// Documentation, guides and API references explain a feature but never date it, and a
// search index stamps them with the day it last crawled them. The first production draft
// presented a three-year-old Cypress requirement as news on the strength of two such
// pages. They stay in the evidence as reference material and count toward nothing.
const referenceSegments = new Set([
  "docs", "doc", "documentation", "guides", "guide", "reference", "references", "api",
  "learn", "tutorial", "tutorials", "handbook", "manual", "faq", "faqs", "library",
  "pricing", "plans", "product", "products",
]);
const datedSegments = new Set([
  "blog", "blogs", "news", "changelog", "changelogs", "release-notes", "releases", "release",
  "announcements", "announcing", "whats-new", "updates", "articles", "posts",
]);
const referenceHosts = ["docs.", "developer.", "developers.", "learn.", "msdn.", "wiki.", "support.", "help."];

// Hosts where anyone can post (pastes, forums, community boards) inherit nothing from
// the vendor domain they sit under: forum.cursor.com is not Cursor speaking.
const userContentHosts = ["gist.", "forum.", "forums.", "community.", "discuss.", "discussions."];

function isReferencePage(url: string) {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.toLowerCase().split("/").filter(Boolean);
  // A repository page is its README, documentation by another name; only the releases
  // page carries a date. The check is structural because a branch called "release/v3.8"
  // otherwise reads as a dated segment.
  if (host === "github.com" || host === "www.github.com") return segments[2] !== "releases";
  const referenceHost = referenceHosts.some((prefix) => host.startsWith(prefix));
  // A help centre files its evergreen pages under "articles"; on such a host only a real
  // blog or changelog segment marks a dated page.
  const dated = segments.some((segment) =>
    datedSegments.has(segment) && !(referenceHost && (segment === "articles" || segment === "posts")));
  if (dated) return false;
  if (referenceHost) return true;
  return segments.some((segment) => referenceSegments.has(segment));
}

export function sourceTier(url: string): SourceTier {
  if (!URL.canParse(url)) return "unrated";
  const host = new URL(url).hostname.toLowerCase();
  if (userContentHosts.some((prefix) => host.startsWith(prefix))) return "unrated";
  const base = matchedDomain(host, primaryDomains) ? "primary" : matchedDomain(host, credibleDomains) ? "credible" : "unrated";
  if (base === "unrated") return base;
  return isReferencePage(url) ? "reference" : base;
}

export function normalizeUrl(url: string) {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

// One first-party source, or two credible ones from different publishers. Counting
// distinct publishers rather than distinct URLs stops a single outlet — or a single
// article cited twice — from standing in for corroboration.
export function meetsEvidenceBar(urls: string[]) {
  const seen = new Set<string>();
  const publishers = new Set<string>();
  for (const url of urls) {
    if (!URL.canParse(url)) continue;
    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const tier = sourceTier(url);
    if (tier === "primary") return true;
    if (tier !== "credible") continue;
    const publisher = matchedDomain(new URL(url).hostname.toLowerCase(), credibleDomains);
    if (publisher) publishers.add(publisher);
  }
  return publishers.size >= 2;
}

// The evidence the model writes from. A theme's search returns a grab bag, and the model
// blends whatever it is given into one post: a pricing page, a stranger's provider
// list and an unrelated structured-output feature became a single "story". Only dated
// sources and the reference pages of the same publishers travel into the prompt, so a
// docs page can add detail to its vendor's announcement but never supply a story of
// its own, and unrated pages never reach the model at all.
export function focusEvidence<T extends { url: string }>(results: T[]): T[] {
  const publishers = new Set<string>();
  for (const result of results) {
    const tier = sourceTier(result.url);
    if (tier !== "primary" && tier !== "credible") continue;
    const publisher = matchedDomain(new URL(result.url).hostname.toLowerCase(), evidenceDomains);
    if (publisher) publishers.add(publisher);
  }
  return results.filter((result) => {
    const tier = sourceTier(result.url);
    if (tier === "primary" || tier === "credible") return true;
    if (tier !== "reference") return false;
    const publisher = matchedDomain(new URL(result.url).hostname.toLowerCase(), evidenceDomains);
    return publisher !== undefined && publishers.has(publisher);
  });
}
