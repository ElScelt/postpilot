import { config, type Config } from "../config";
import { dayIndex } from "../scheduling/time";

// A theme's id as written in postpilot.config.ts, such as "frontend".
export type PostTheme = string;
export type ThemeDefinition = Config["themes"][PostTheme];

export function themeDefinitions(): Config["themes"] {
  return config().themes;
}

export function themeIds(themes = themeDefinitions()): PostTheme[] {
  return Object.keys(themes);
}

export function themeDefinition(theme: PostTheme, themes = themeDefinitions()): ThemeDefinition {
  const definition = themes[theme];
  if (!definition) throw new Error(`Unknown theme "${theme}"; choose one of ${themeIds(themes).join(", ")}.`);
  return definition;
}

export function isPostTheme(value: string, themes = themeDefinitions()) {
  return Object.hasOwn(themes, value);
}

// Least recently used first, so the themes cycle even though runs land on only a few
// nights a week. Never-used themes are ordered by the calendar so two fresh deployments
// on different days do not both start on the same theme.
export function themeOrder(recentThemes: string[], now = new Date(), themes = themeIds()): PostTheme[] {
  const start = dayIndex(now) % themes.length;
  const rotated = [...themes.slice(start), ...themes.slice(0, start)];
  return rotated
    .map((theme, index) => ({ theme, index, lastUsed: recentThemes.lastIndexOf(theme) }))
    .sort((a, b) => a.lastUsed - b.lastUsed || a.index - b.index)
    .map((entry) => entry.theme);
}
