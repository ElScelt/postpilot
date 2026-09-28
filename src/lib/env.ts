// Every variable the app reads. The README's table lists the same names.
export const requiredVariables = [
  "LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_REDIRECT_URI", "LINKEDIN_STATE_SECRET",
  "APP_URL", "AUTOMATION_SECRET", "GROQ_API_KEY", "TAVILY_API_KEY",
  "QSTASH_TOKEN", "QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY",
] as const;

const optionalVariables = [
  "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN",
  "NTFY_TOPIC", "NTFY_URL", "NTFY_TOKEN", "LINKEDIN_MEMBER_ID", "HEALTHCHECK_URL", "GROQ_MODEL", "VERCEL_ENV",
] as const;

export type RequiredVariable = (typeof requiredVariables)[number];
export type Variable = RequiredVariable | (typeof optionalVariables)[number];

export type Environment = Partial<Record<string, string>>;

// A variable left blank in Vercel or .env.local counts as unset, and a value loses the
// whitespace around it: a pasted secret easily carries a trailing newline or \r, which
// would otherwise turn "use the default" into an empty URL or model name.
export function envValue(name: Variable, source: Environment = process.env) {
  return source[name]?.trim() || undefined;
}

export function required(name: RequiredVariable): string {
  const value = envValue(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// The canonical production origin, without a trailing slash.
export function appUrl() {
  return required("APP_URL").replace(/\/$/, "");
}
