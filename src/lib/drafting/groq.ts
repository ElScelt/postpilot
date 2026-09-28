import { z } from "zod";
import { envValue, required } from "../env";
import { sleep } from "../async";

export const groqEndpoint = "https://api.groq.com/openai/v1/chat/completions";

// Strict structured output and the reasoning_effort values the requests use exist only
// on the gpt-oss family; another model would return best-effort JSON or a 400 at 21:00.
export const supportedGroqModels = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"] as const;
export const defaultGroqModel: (typeof supportedGroqModels)[number] = "openai/gpt-oss-120b";

export function groqModel() {
  const model = envValue("GROQ_MODEL") ?? defaultGroqModel;
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

// Retry-After for the per-minute token limit is only a lower bound. On a live run the
// review, sent right after the draft had used half the minute's budget, was
// refused again after waiting the suggested 1.4 seconds twice. Later retries therefore
// wait longer, about a minute in all, by when the draft's tokens have left the window.
const minimumRetryWaitsMs = [0, 20_000, 40_000];

// gpt-oss-120b on Groq answers a draft in seconds. A request that hangs for a minute is
// not going to finish inside the run.
const requestTimeoutMs = 60_000;

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

// The free tier's per-minute token budget counts the prompt and the completion allowance
// together, so a request can be refused before the model sees it. The draft is asked
// again in a compact form rather than counted as a failed attempt.
export class GroqRequestTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroqRequestTooLargeError";
  }
}

export class GroqRateLimitError extends Error {
  constructor(message: string, readonly retryAfterSeconds: number | undefined) {
    super(message);
    this.name = "GroqRateLimitError";
  }
}

// A wait for the rate limit that would end after `deadline` is not started: the platform
// would kill the run mid-sleep, and the run would end without recording why.
// How one call is made: the fetch it goes through, how it waits out a rate limit, and
// the run's deadline, past which no wait starts.
export type GroqCall = {
  fetcher?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  deadline?: number;
};

export async function requestGroq(init: RequestInit, { fetcher = fetch, wait = sleep, deadline = Infinity }: GroqCall = {}) {
  const send = () => fetcher(groqEndpoint, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
  let response = await send();
  for (let retry = 0; response.status === 429 && retry < minimumRetryWaitsMs.length; retry += 1) {
    const retryAfter = retryAfterSeconds(response);
    if (retryAfter !== undefined && retryAfter * 1000 > maxRetryWaitMs) {
      throw new GroqRateLimitError(
        `Groq rate limit reached and Retry-After is ${Math.round(retryAfter)} seconds: ${await response.text()}`,
        retryAfter,
      );
    }
    const suggested = retryAfter !== undefined && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : 10_000;
    const delay = Math.max(suggested, minimumRetryWaitsMs[retry]!);
    if (Date.now() + delay > deadline) {
      throw new Error(`Out of time for this run: Groq's rate limit asked for a ${Math.round(delay / 1000)}-second wait.`);
    }
    await wait(delay);
    response = await send();
  }
  return response;
}

// The text of one completion, or a descriptive error. Reasoning tokens share the
// completion budget with the answer, so a finish_reason of "length" means the JSON was
// cut off and must not reach the parser.
export async function completeGroq(init: RequestInit, label: string, call: GroqCall = {}) {
  const response = await requestGroq(init, call);
  if (response.status === 413) {
    throw new GroqRequestTooLargeError(`Groq refused the ${label} request as too large for the model's per-minute token limit: ${await response.text()}`);
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
