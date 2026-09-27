import { NextRequest, NextResponse } from "next/server";
import { validRejectToken } from "@/lib/security/reject-token";

// The signed id from a reject link, or null when the signature does not match.
export function rejectTarget(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  const token = request.nextUrl.searchParams.get("token");
  return id && validRejectToken(id, token) ? id : null;
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

export function page(title: string, body: string) {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(title)}</title>`
    + `<body style="font:16px/1.5 system-ui;margin:0;padding:2rem;max-width:40rem">${body}</body>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export const buttonStyle = "font:inherit;padding:.75rem 1.25rem;border-radius:.5rem;border:0;color:#fff";

export function invalidLinkPage() {
  return page("Invalid link", "<h1>Invalid or expired link</h1>");
}
