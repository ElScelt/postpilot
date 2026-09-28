import type { NextRequest } from "next/server";
import { handleLinkedInCallback } from "./handler";

export function GET(request: NextRequest) {
  return handleLinkedInCallback(request);
}
