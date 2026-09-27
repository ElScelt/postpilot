import { z } from "zod";
import { NextResponse } from "next/server";
import { runAutomation } from "@/lib/automation";
import { authorizeRunRequest, isQStashSigned } from "@/lib/security/request-auth";
import { recordAutomationRun } from "@/lib/storage/runs";
import { DraftRejectedError } from "@/lib/drafting/pipeline";
import { pingHeartbeat } from "@/lib/notify/heartbeat";
import { notifyOperator } from "@/lib/notify/ntfy";
import { errorMessage } from "@/lib/errors";

// Research plus two drafting calls take 30 to 120 seconds; this is the Fluid compute
// default, stated here so a project without Fluid fails at deploy time instead of
// killing every run at ten seconds.
export const maxDuration = 300;

// The QStash schedule retries a failed run three times, so the fourth attempt is the last.
const scheduleRetries = 3;

// The body carries nothing. Schedules created before the run lost its slot still send
// {"slot":"morning"}, so that shape stays accepted.
const requestSchema = z.object({ slot: z.literal("morning").optional() });

function validBody(body: string) {
  if (!body.trim()) return true;
  try {
    return requestSchema.safeParse(JSON.parse(body)).success;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const body = await request.text();
  if (!(await authorizeRunRequest(request, body))) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (!validBody(body)) {
    return new NextResponse("The request body must be empty or a JSON object.", { status: 400 });
  }
  const signed = isQStashSigned(request);
  const finalAttempt = !signed || Number(request.headers.get("upstash-retried") ?? 0) >= scheduleRetries;
  try {
    const result = await runAutomation(new Date(), {}, { manual: !signed, finalAttempt });
    await pingHeartbeat(true);
    return NextResponse.json(result);
  } catch (error) {
    await pingHeartbeat(false);
    const message = errorMessage(error);
    console.error("LinkedIn automation failed:", message);
    // A rejected draft was already recorded with its attempts; anything else is recorded
    // here. Either way the 500 lets QStash retry with a fresh sample.
    if (!(error instanceof DraftRejectedError)) {
      await recordAutomationRun({ ranAt: new Date().toISOString(), status: "failed", reason: message });
      if (finalAttempt) {
        await notifyOperator({ title: "LinkedIn automation run failed", body: message, priority: 4 });
      }
    }
    return NextResponse.json({ status: "failed", error: message }, { status: 500 });
  }
}
