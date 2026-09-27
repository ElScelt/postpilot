import { supportedGroqModels } from "./drafting/groq";

// The dashboard's setup card. A first deploy is diagnosed from the page itself, by
// name, rather than from a 500 and the Vercel logs. Secrets never leave the server:
// only variable names, public URLs and derived facts are reported.
export type SetupCheck = { level: "error" | "warning" | "note"; text: string };

export type SetupEnvironment = Partial<Record<string, string>>;

export type SetupContext = {
  // The host this page was served from, so a wrong APP_URL shows up before QStash
  // starts delivering to it.
  servingHost?: string;
  // The member id of the stored LinkedIn token, if any.
  memberId?: string;
};

export const requiredVariables = [
  "LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_REDIRECT_URI", "LINKEDIN_STATE_SECRET",
  "APP_URL", "AUTOMATION_SECRET", "GROQ_API_KEY", "TAVILY_API_KEY",
  "QSTASH_TOKEN", "QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY",
] as const;

export const callbackPath = "/api/auth/linkedin/callback";

export function checkSetup(env: SetupEnvironment, context: SetupContext = {}): SetupCheck[] {
  const checks: SetupCheck[] = [];
  const error = (text: string) => checks.push({ level: "error", text });
  const warning = (text: string) => checks.push({ level: "warning", text });
  const note = (text: string) => checks.push({ level: "note", text });

  const missing = requiredVariables.filter((name) => !env[name]?.trim());
  if (missing.length) error(`Missing required variables: ${missing.join(", ")}.`);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    error("Redis is not configured. Connect the Upstash Redis integration, which adds UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.");
  }

  const appUrl = env.APP_URL?.trim();
  const origin = appUrl && URL.canParse(appUrl) ? new URL(appUrl) : undefined;
  if (appUrl && (!origin || origin.protocol !== "https:")) {
    error(`APP_URL must be an https origin such as https://your-project.vercel.app (it is "${appUrl}").`);
  } else if (origin && (origin.pathname !== "/" || appUrl?.endsWith("/") || origin.search || origin.hash)) {
    error(`APP_URL must be the bare origin with no path and no trailing slash (it is "${appUrl}").`);
  } else if (origin && context.servingHost && origin.host !== context.servingHost) {
    const text = `This page is served from ${context.servingHost} but APP_URL is ${origin.origin}. QStash calls APP_URL, so on the production domain the two must match.`;
    if (env.VERCEL_ENV === "preview") note(`${text} On a preview deployment that is expected.`);
    else warning(text);
  }
  const redirect = env.LINKEDIN_REDIRECT_URI?.trim();
  if (origin && redirect && redirect !== `${origin.origin}${callbackPath}`) {
    error(`LINKEDIN_REDIRECT_URI should be ${origin.origin}${callbackPath} (it is "${redirect}"), and the same URL must be listed under Authorized redirect URLs in the LinkedIn app.`);
  }

  if (!env.NTFY_TOPIC?.trim()) warning("NTFY_TOPIC is not set: drafts publish unreviewed and nothing alerts you.");

  const wanted = env.LINKEDIN_MEMBER_ID?.trim();
  if (context.memberId && !wanted) {
    warning(`LinkedIn is connected as member ${context.memberId}. Set LINKEDIN_MEMBER_ID to that value and redeploy so nobody else can rebind this deployment.`);
  } else if (context.memberId && wanted && wanted !== context.memberId) {
    error(`LINKEDIN_MEMBER_ID is ${wanted} but the connected member is ${context.memberId}. Reconnect LinkedIn as the intended member or correct the variable.`);
  }

  const model = env.GROQ_MODEL?.trim();
  if (model && !(supportedGroqModels as readonly string[]).includes(model)) {
    error(`GROQ_MODEL "${model}" is not supported; leave it unset or use one of ${supportedGroqModels.join(", ")}.`);
  }

  if (!env.HEALTHCHECK_URL?.trim()) note("HEALTHCHECK_URL is not set: a run that never fires stays silent. Optional.");
  return checks;
}
