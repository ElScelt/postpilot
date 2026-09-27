"use client";

import { useActionState } from "react";
import { editPost, rejectPost, type ActionResult } from "./actions";

const button = (tone: "primary" | "danger" | "plain") => ({
  font: "inherit", padding: ".5rem 1rem", borderRadius: ".5rem", border: 0, cursor: "pointer",
  background: { primary: "#1d4ed8", danger: "#b91c1c", plain: "#e4e4e7" }[tone],
  color: tone === "plain" ? "#18181b" : "#fff",
});

// A submit button that can also be its own form, for actions that take no input.
export function ActionButton({ action, label, tone }: { action?: () => Promise<ActionResult>; label: string; tone: "primary" | "danger" | "plain" }) {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null) => (action ? action() : null),
    null as ActionResult | null,
  );
  const content = (
    <>
      <button type="submit" style={button(tone)} disabled={pending} formAction={action ? formAction : undefined}>
        {pending ? "Working…" : label}
      </button>
      {state && <p style={{ color: state.ok ? "#166534" : "#991b1b", margin: ".5rem 0 0" }}>{state.message}</p>}
    </>
  );
  return action ? <form action={formAction}>{content}</form> : content;
}

export function EditForm({ id, text, maxLength }: { id: string; text: string; maxLength: number }) {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => editPost(formData),
    null as ActionResult | null,
  );
  return (
    <form action={formAction} style={{ display: "grid", gap: ".5rem" }}>
      <input type="hidden" name="id" value={id} />
      <textarea
        name="text"
        defaultValue={text}
        rows={10}
        maxLength={maxLength}
        style={{ font: "inherit", padding: ".75rem", borderRadius: ".5rem", border: "1px solid #d4d4d8", width: "100%", boxSizing: "border-box" }}
      />
      <div>
        <button type="submit" style={button("plain")} disabled={pending}>{pending ? "Saving…" : "Save edited text"}</button>
        {state && <span style={{ color: state.ok ? "#166534" : "#991b1b", marginLeft: ".75rem" }}>{state.message}</span>}
      </div>
    </form>
  );
}

export function RejectForm({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => rejectPost(formData),
    null as ActionResult | null,
  );
  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" style={button("danger")} disabled={pending}>{pending ? "Rejecting…" : "Reject this post"}</button>
      {state && <span style={{ color: state.ok ? "#166534" : "#991b1b", marginLeft: ".75rem" }}>{state.message}</span>}
    </form>
  );
}
