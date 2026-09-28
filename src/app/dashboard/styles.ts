import type { SetupCheck } from "@/lib/setup-check";

export type Tone = "ok" | "warn" | "bad" | "idle";

export const styles = {
  page: { font: "15px/1.5 system-ui, sans-serif", margin: "0 auto", padding: "1.5rem", maxWidth: "64rem", color: "#18181b" },
  grid: { display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))" },
  card: { border: "1px solid #e4e4e7", borderRadius: ".75rem", padding: "1rem", background: "#fff" },
  heading: { fontSize: "1rem", margin: "0 0 .5rem" },
  muted: { color: "#52525b" },
  pre: { whiteSpace: "pre-wrap", font: "inherit", background: "#f4f4f5", padding: ".75rem", borderRadius: ".5rem", margin: ".5rem 0" },
  badge: (tone: Tone) => ({
    display: "inline-block", padding: ".1rem .5rem", borderRadius: "999px", fontSize: ".85rem",
    background: { ok: "#dcfce7", warn: "#fef3c7", bad: "#fee2e2", idle: "#e4e4e7" }[tone],
    color: { ok: "#166534", warn: "#92400e", bad: "#991b1b", idle: "#3f3f46" }[tone],
  }),
} as const;

export const levelColor: Record<SetupCheck["level"], string> = { error: "#991b1b", warning: "#92400e", note: "#52525b" };
