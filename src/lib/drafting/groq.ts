import { z } from "zod";
import { required } from "../env";
import { sleep } from "../scheduling/time";

export const groqEndpoint = "https://api.groq.com/openai/v1/chat/completions";

// Strict structured output and the reasoning_effort values the requests use exist only
// on the gpt-oss family; another model would return best-effort JSON or a 400 at 21:00.
export const supportedGroqModels = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"] as const;
export const defaultGroqModel: (typeof supportedGroqModels)[number] = "openai/gpt-oss-120b";

export function groqModel() {
  const model = process.env.GROQ_MODEL ?? defaultGroqModel;
  if (!(supportedGroqModels as readonly string[]).includes(model)) {
    throw new Error(`GROQ_MODEL must be one of ${supportedGroqModels.join(", ")}; received "${model}".`);
  }
  return model;
}

export type CompletionRequest = {
  prompt: string;
  reasoning: "low" | "medium";
  // Reasoning and answer share this budget.
  maxTokens: number;
  responseFormat: object;
};

export function groqRequest(request: CompletionRequest): RequestInit {
  return {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${required("GROQ_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: groqModel(),
      messages: [{ role: "user", content: request.prompt }],
      reasoning_effort: request.reasoning,
      max_completion_tokens: request.maxTokens,
      response_format: request.responseFormat,
    }),
  };
}

const responseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable().optional() }),
    finish_reason: z.string().nullable().optional(),
  })).min(1),
});

// Per-minute limits reset within a minute, so a short Retry-After is worth waiting for.
// A daily limit says "try again in six hours"; waiting 30 seconds three times for that
// only delays the same failure, so the run reports it instead.
const maxRetryWaitMs = 60_000;

// Strict JSON mode validates the answer server-side and answers 400 json_validate_failed
// when it does not fit the schema. An empty failed_generation means the model emitted no
// answer at all, which is what reasoning spending the whole completion budget looks like.
export class GroqInvalidJsonError extends Error {
  constructor(message: string, readonly failedGeneration: string) {
    super(message);
    this.name = "GroqInvalidJsonError";
  }
}

const errorSchema = z.object({ error: z.object({ failed_generation: z.string().optional() }).optional() });

function failedGeneration(body: string) {
  try {
    return errorSchema.parse(JSON.parse(body)).error?.failed_generation ?? "";
  } catch {
    return "";
  }
}

export class GroqRateLimitError extends Error {
  constructor(message: string, readonly retryAfterSeconds: number | undefined) {
    super(message);
    this.name = "GroqRateLimitError";
  }
}

export async function requestGroq(
  init: RequestInit,
  fetcher: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<void> = sleep,
) {
  let response = await fetcher(groqEndpoint, init);
  for (let retry = 0; response.status === 429 && retry < 2; retry += 1) {
    const retryAfter = retryAfterSeconds(response);
    if (retryAfter !== undefined && retryAfter * 1000 > maxRetryWaitMs) {
      throw new GroqRateLimitError(
        `Groq rate limit reached and Retry-After is ${Math.round(retryAfter)} seconds: ${await response.text()}`,
        retryAfter,
      );
    }
    await wait(retryAfter !== undefined && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : 10_000);
    response = await fetcher(groqEndpoint, init);
  }
  return response;
}

// The text of one completion, or a descriptive error. Reasoning tokens share the
// completion budget with the answer, so a finish_reason of "length" means the JSON was
// cut off and must not reach the parser.
export async function completeGroq(
  init: RequestInit,
  label: string,
  fetcher: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<void> = sleep,
) {
  const response = await requestGroq(init, fetcher, wait);
  if (response.status === 413) {
    throw new Error(`Groq refused the ${label} request as too large for the model's per-minute token limit: ${await response.text()}`);
  }
  if (!response.ok) {
    const body = await response.text();
    if (response.status === 400 && body.includes("json_validate_failed")) {
      const failed = failedGeneration(body);
      throw new GroqInvalidJsonError(
        `Groq could not validate the ${label} against the schema${failed ? "" : "; the model produced no answer, most likely because reasoning used the whole completion budget"}: ${body}`,
        failed,
      );
    }
    throw new Error(`Groq ${label} generation failed (${response.status}): ${body}`);
  }
  const payload = responseSchema.parse(await response.json());
  const choice = payload.choices[0];
  if (choice?.finish_reason === "length") {
    throw new Error(`Groq stopped the ${label} early: the reasoning and answer exceeded max_completion_tokens.`);
  }
  const text = choice?.message.content;
  if (!text) throw new Error(`Groq returned no ${label}.`);
  return text;
}

function retryAfterSeconds(response: Response) {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}
