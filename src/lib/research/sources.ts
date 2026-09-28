import { config, type Config } from "../config";

export type SourceTier = "primary" | "credible" | "reference" | "unrated";

export type EvidenceSettings = Config["evidence"];

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

function primary(evidence: EvidenceSettings) {
  return [...primaryDomains, ...evidence.primaryDomains];
}

function credible(evidence: EvidenceSettings) {
  return [...credibleDomains, ...evidence.credibleDomains];
}

// Every domain that can contribute to the evidence bar. Searching these first keeps
// the research aligned with the standard the draft is later judged against.
export function evidenceDomains(evidence: EvidenceSettings = config().evidence) {
  return [...new Set([...primary(evidence), ...credible(evidence)])];
}

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

// Account, sign-in, store and status portals sit under a vendor domain but announce
// nothing. myaccount.microsoft.com came back as a dated "primary" result for most themes
// on the first live test, which alone would have cleared the evidence bar.
const portalHosts = [
  "myaccount.", "account.", "accounts.", "login.", "signin.", "signup.", "auth.", "portal.",
  "status.", "store.", "shop.", "careers.", "jobs.",
];

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

export function sourceTier(url: string, evidence: EvidenceSettings = config().evidence): SourceTier {
  if (!URL.canParse(url)) return "unrated";
  const host = new URL(url).hostname.toLowerCase();
  if ([...userContentHosts, ...portalHosts].some((prefix) => host.startsWith(prefix))) return "unrated";
  const base = matchedDomain(host, primary(evidence)) ? "primary" : matchedDomain(host, credible(evidence)) ? "credible" : "unrated";
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
export function meetsEvidenceBar(urls: string[], evidence: EvidenceSettings = config().evidence) {
  const seen = new Set<string>();
  const publishers = new Set<string>();
  for (const url of urls) {
    if (!URL.canParse(url)) continue;
    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const tier = sourceTier(url, evidence);
    if (tier === "primary") return true;
    if (tier !== "credible") continue;
    const publisher = matchedDomain(new URL(url).hostname.toLowerCase(), credible(evidence));
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
export function focusEvidence<T extends { url: string }>(results: T[], evidence: EvidenceSettings = config().evidence): T[] {
  const domains = evidenceDomains(evidence);
  const publishers = new Set<string>();
  for (const result of results) {
    const tier = sourceTier(result.url, evidence);
    if (tier !== "primary" && tier !== "credible") continue;
    const publisher = matchedDomain(new URL(result.url).hostname.toLowerCase(), domains);
    if (publisher) publishers.add(publisher);
  }
  return results.filter((result) => {
    const tier = sourceTier(result.url, evidence);
    if (tier === "primary" || tier === "credible") return true;
    if (tier !== "reference") return false;
    const publisher = matchedDomain(new URL(result.url).hostname.toLowerCase(), domains);
    return publisher !== undefined && publishers.has(publisher);
  });
}
