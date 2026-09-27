import { z } from "zod";
import { required } from "../env";
import { recentDays } from "../scheduling/time";
import { config } from "../config";
import { evidenceDomains, meetsEvidenceBar, normalizeUrl } from "./sources";
import { themeDefinition, type PostTheme } from "./themes";
import { errorMessage } from "../errors";

export type ResearchResult = {
  title: string;
  url: string;
  content: string;
  publishedDate: string;
};

const responseSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    url: z.string(),
    content: z.string().default(""),
    published_date: z.string().nullable().optional(),
  })),
});

type SearchPass = { includeDomains: string[]; topic: "news" | "general" };

// Passes escalate from the strictest to the widest and stop as soon as the merged results
// clear the evidence bar. Tavily's news index is built from news publishers and rarely
// carries a vendor's own release notes, so the second pass asks the general index for
// the same allowlisted domains before the search opens up to the whole web. A narrow
// pass must never silence the automation outright, so its failure is logged and the
// next pass runs; a genuine outage fails on the last one.
const passes: SearchPass[] = [
  { includeDomains: evidenceDomains, topic: "news" },
  { includeDomains: evidenceDomains, topic: "general" },
  { includeDomains: [], topic: "news" },
];

export async function searchThemeEvidence(
  theme: PostTheme,
  now = new Date(),
  fetcher: typeof fetch = fetch,
) {
  const merged = new Map<string, ResearchResult>();
  for (const [index, pass] of passes.entries()) {
    let results: ResearchResult[];
    try {
      results = await runSearches(now, fetcher, pass, theme);
    } catch (error) {
      if (index === passes.length - 1) throw error;
      console.error(`Tavily ${pass.topic} search over ${pass.includeDomains.length} domains failed:`, errorMessage(error));
      continue;
    }
    for (const result of results) {
      const key = normalizeUrl(result.url);
      if (!merged.has(key)) merged.set(key, result);
    }
    if (meetsEvidenceBar([...merged.values()].map((result) => result.url))) break;
  }
  return [...merged.values()];
}

// Every query of the theme runs, and the results merge by URL in query order, so the
// vendor-change query and the practitioner query each contribute their top hits.
async function runSearches(
  now: Date,
  fetcher: typeof fetch,
  pass: SearchPass,
  theme: PostTheme,
) {
  const batches = await Promise.all(
    themeDefinition(theme).queries.map((query) => runSearch(query, now, fetcher, pass)),
  );
  const merged = new Map<string, ResearchResult>();
  for (const result of batches.flat()) {
    const key = normalizeUrl(result.url);
    if (!merged.has(key)) merged.set(key, result);
  }
  return [...merged.values()];
}

async function runSearch(
  query: string,
  now: Date,
  fetcher: typeof fetch,
  pass: SearchPass,
) {
  const window = recentDays(now, config().limits.sourceWindowDays);
  const response = await fetcher("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${required("TAVILY_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      topic: pass.topic,
      search_depth: "advanced",
      // One chunk gave the model 600 characters to write 200 words from; the context
      // paragraphs came out thin and the insight generic.
      chunks_per_source: 2,
      // The bar now needs two distinct publishers, so the draft needs more candidates.
      max_results: 10,
      // Dates belong in the filters, not the query text: Tavily filters by calendar day.
      start_date: window.oldest,
      end_date: window.latest,
      include_answer: false,
      include_raw_content: false,
      ...(pass.includeDomains.length ? { include_domains: pass.includeDomains } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Tavily search failed (${response.status}): ${await response.text()}`);
  const payload = responseSchema.parse(await response.json());
  return payload.results.flatMap((result): ResearchResult[] => {
    const publishedDate = normalizeDate(result.published_date);
    if (!publishedDate || !URL.canParse(result.url)) return [];
    return [{ ...result, publishedDate }];
  });
}

function normalizeDate(value?: string | null) {
  if (!value) return "";
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "";
}
