import { z } from "zod";
import type { Draft, ResearchSource } from "./types";
import { GroqInvalidJsonError } from "./groq";
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

const paragraphFields = ["hook", "context", "insight", "takeaway", "question"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Strict mode on a live run twice answered with every paragraph field holding a copy of
// the whole paragraph object ({"hook": {"hook": "...", "context": "", ...}}), and the
// night was lost although the text was all there. Such an answer is unwrapped; the
// result is judged by the validator like any other draft. A field whose object holds
// several different texts is ambiguous and is not guessed at.
export function repairDraftJson(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.paragraphs)) return undefined;
  const paragraphs: Record<string, unknown> = { ...parsed.paragraphs };
  let changed = false;
  for (const field of paragraphFields) {
    if (typeof paragraphs[field] === "string") continue;
    const flattened = flattenParagraph(paragraphs[field], field);
    if (flattened === undefined) return undefined;
    paragraphs[field] = flattened;
    changed = true;
  }
  if (!changed) return undefined;
  const repaired = { ...parsed, paragraphs };
  return responseSchema.safeParse(repaired).success ? JSON.stringify(repaired) : undefined;
}

// A strict-JSON refusal whose text only needs its paragraphs unwrapped.
export function repairedAnswer(error: unknown) {
  return error instanceof GroqInvalidJsonError ? repairDraftJson(error.failedGeneration) : undefined;
}

function flattenParagraph(value: unknown, field: string) {
  // A checklist sent as an array of lines.
  if (Array.isArray(value)) {
    return value.every((line) => typeof line === "string")
      ? value.map((line: string) => line.trim()).filter(Boolean).join("\n")
      : undefined;
  }
  if (!isRecord(value)) return undefined;
  const own = value[field];
  if (typeof own === "string" && own.trim()) return own;
  const texts = [...new Set(Object.values(value)
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== ""))];
  return texts.length === 1 ? texts[0] : undefined;
}

// The correction for an answer Groq refused as invalid JSON. "Empty or not valid JSON"
// told the model nothing, and it repeated the same nested shape on its second attempt.
export function draftJsonProblem(failedGeneration: string) {
  if (!failedGeneration.trim()) {
    return "The previous answer was empty, most likely because the reasoning used the whole budget. Keep the reasoning short and answer with the JSON object only.";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(failedGeneration);
  } catch {
    return "The previous answer was not valid JSON (it was cut off or malformed). Answer with one complete JSON object only.";
  }
  const result = responseSchema.safeParse(parsed);
  const issues = result.success ? [] : result.error.issues.slice(0, 4)
    .map((issue) => `${issue.path.join(".") || "the answer"}: ${issue.message}`);
  return `The previous answer did not match the required JSON shape${issues.length ? ` (${issues.join("; ")})` : ""}. Every paragraph field (hook, context, insight, takeaway, question) is one plain string, never an object or an array; write a checklist as one string with each item on its own line.`;
}

const trackingParams =/^(?:utm_\w+|ref|source|fbclid|gclid)$/i;

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
