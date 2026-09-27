import { z } from "zod";
import type { Draft, ResearchSource } from "./types";
import type { ResearchResult } from "../research/tavily";
import { normalizeUrl, sourceTier } from "../research/sources";
import { isPostTheme, type PostTheme } from "../research/themes";

export type DraftDecision =
  | { shouldPost: false; reason: string }
  | ({ shouldPost: true; reason: string; theme: PostTheme } & Draft);

const responseSchema = z.object({
  shouldPost: z.boolean(),
  reason: z.string(),
  topic: z.string(),
  theme: z.string().refine((value) => isPostTheme(value), "theme is not one of the configured themes"),
  paragraphs: z.object({
    hook: z.string(),
    context: z.string(),
    insight: z.string(),
    takeaway: z.string(),
    question: z.string(),
  }),
  // The prompt asks for one to three URLs; the strict schema cannot express a maximum,
  // so a fourth is dropped here rather than failing the night.
  sourceUrls: z.array(z.string()),
});

const maxSources = 3;

export function parseDraftDecision(text: string, results: ResearchResult[]): DraftDecision {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = responseSchema.parse(JSON.parse(cleaned));
  if (!parsed.shouldPost) return { shouldPost: false, reason: parsed.reason };
  const evidence = new Map(results.map((result) => [looseUrlKey(result.url), result]));
  // The same article cited twice is one source, not two.
  const uniqueUrls = [...new Map(parsed.sourceUrls.map((url) => [looseUrlKey(url), url])).values()];
  const sources = uniqueUrls.slice(0, maxSources).map((url) => sourceFromResult(url, evidence));
  return {
    shouldPost: true,
    reason: parsed.reason,
    topic: parsed.topic.trim().slice(0, 120),
    theme: parsed.theme,
    text: Object.values(parsed.paragraphs).map((paragraph) => paragraph.trim())
      .filter(Boolean).join("\n\n"),
    sources,
  };
}

const trackingParams = /^(?:utm_\w+|ref|source|fbclid|gclid)$/i;

// The model is told to copy URLs verbatim, but it drops tracking parameters, the scheme
// or a leading www. often enough that an exact match failed whole nights. Two distinct
// articles never differ only in those parts, so matching without them is safe.
export function looseUrlKey(url: string) {
  if (!URL.canParse(url)) return url.trim().toLowerCase();
  const parsed = new URL(normalizeUrl(url));
  for (const name of [...parsed.searchParams.keys()]) {
    if (trackingParams.test(name)) parsed.searchParams.delete(name);
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const query = parsed.searchParams.toString();
  return `${host}${parsed.pathname.replace(/\/$/, "")}${query ? `?${query}` : ""}`;
}

function sourceFromResult(url: string, evidence: Map<string, ResearchResult>): ResearchSource {
  const result = evidence.get(looseUrlKey(url));
  if (!result) throw new Error(`Source URL was not present in the evidence: ${url}. Copy sourceUrls exactly from the evidence.`);
  const tier = sourceTier(result.url);
  return {
    title: result.title,
    url: result.url,
    publishedDate: result.publishedDate,
    primary: tier === "primary",
    credible: tier === "credible",
  };
}
