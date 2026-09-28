import { handlePublish } from "./handler";

export const maxDuration = 60;

export function POST(request: Request) {
  return handlePublish(request);
}
