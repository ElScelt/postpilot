import { handleRunRequest } from "./handler";

// Research plus two drafting calls take 30 to 120 seconds; this is the Fluid compute
// default, stated here so a project without Fluid fails at deploy time instead of
// killing every run at ten seconds.
export const maxDuration = 300;

export function POST(request: Request) {
  return handleRunRequest(request);
}
