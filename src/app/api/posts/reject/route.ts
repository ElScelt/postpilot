import type { NextRequest } from "next/server";
import { handleReject, handleReviewPage } from "./handler";

export function GET(request: NextRequest) {
  return handleReviewPage(request);
}

export function POST(request: NextRequest) {
  return handleReject(request);
}
