import { z } from "zod";
import userConfig from "../../../postpilot.config";
import { defaultPersona, defaultThemes } from "./defaults";

// Everything about what gets posted and when lives in postpilot.config.ts; secrets and
// infrastructure stay in environment variables. The file is parsed once, with defaults
// filled in, and a mistake fails loudly with the field that is wrong.

export const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const hour = z.number().int().min(0).max(23);

function isTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const themeSchema = z.strictObject({
  label: z.string().min(1),
  queries: z.array(z.string().min(1)).min(1),
  brief: z.string().min(1),
});

const configSchema = z.strictObject({
  timeZone: z.string().refine(isTimeZone, "must be an IANA time zone such as UTC or Europe/Tallinn").default("UTC"),
  publishHour: hour.default(9),
  schedule: z.strictObject({
    days: z.array(z.enum(weekdays)).min(1).default(["sun", "tue", "thu"]),
    runHour: hour.default(21),
  }).prefault({}),
  persona: z.strictObject({
    role: z.string().min(1).default(defaultPersona.role),
    scale: z.string().min(1).default(defaultPersona.scale),
    stack: z.array(z.string().min(1)).default([]),
    avoidTopics: z.array(z.string().min(1)).default(defaultPersona.avoidTopics),
    voice: z.string().default(""),
  }).prefault({}),
  limits: z.strictObject({
    minWords: z.number().int().positive().default(140),
    maxWords: z.number().int().positive().default(220),
    maxHookLength: z.number().int().min(40).default(160),
    sourceWindowDays: z.number().int().min(1).max(30).default(14),
  }).prefault({}).refine((limits) => limits.minWords < limits.maxWords, "minWords must be below maxWords"),
  themes: z.record(z.string(), themeSchema)
    .refine((themes) => Object.keys(themes).length > 0, "at least one theme is required")
    .refine((themes) => Object.keys(themes).every((id) => /^[a-z0-9-]+$/.test(id)), "theme ids are lowercase words joined by hyphens")
    .default(defaultThemes),
});

// What postpilot.config.ts may contain: every field is optional.
export type PostpilotConfig = z.input<typeof configSchema>;
// The configuration with every default filled in.
export type Config = z.output<typeof configSchema>;

export function loadConfig(input: unknown): Config {
  const result = configSchema.safeParse(input);
  if (!result.success) throw new Error(`postpilot.config.ts is invalid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

let loaded: Config | undefined;

// The test suite sets POSTPILOT_CONFIG=defaults (test/setup.ts) so its expectations hold
// whatever the owner put in postpilot.config.ts.
export function config(): Config {
  loaded ??= loadConfig(process.env.POSTPILOT_CONFIG === "defaults" ? {} : userConfig);
  return loaded;
}

export function userConfigFile(): unknown {
  return userConfig;
}
