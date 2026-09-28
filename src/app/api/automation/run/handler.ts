import { z } from "zod";
import { NextResponse } from "next/server";
import { runAutomation } from "@/lib/automation";
import { authorizeRunRequest, isQStashSigned, verifyQStashSignature } from "@/lib/security/request-auth";
import { recordAutomationRun } from "@/lib/storage/runs";
import { DraftRejectedError } from "@/lib/drafting/pipeline";
import { pingHeartbeat } from "@/lib/notify/heartbeat";
import { notifyOperator } from "@/lib/notify/ntfy";
import { errorMessage } from "@/lib/errors";
import { deliveryAttempt } from "@/lib/scheduling/qstash";
import { runRetries } from "@/lib/limits";

// Everything the run route calls, injectable so tests drive the handler with fakes.
// route.ts may only export route fields, which is why this lives beside it.
export type RunRequestDeps = {
  runAutomation: typeof runAutomation;
  pingHeartbeat: typeof pingHeartbeat;
  recordAutomationRun: typeof recordAutomationRun;
  notifyOperator: typeof notifyOperator;
  verifySignature: typeof verifyQStashSignature;
};

const productionDeps: RunRequestDeps = {
  runAutomation, pingHeartbeat, recordAutomationRun, notifyOperator, verifySignature: verifyQStashSignature,
};

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

export async function handleRunRequest(request: Request, overrides: Partial<RunRequestDeps> = {}) {
  const deps = { ...productionDeps, ...overrides };
  const body = await request.text();
  if (!(await authorizeRunRequest(request, body, deps.verifySignature))) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (!validBody(body)) {
    return new NextResponse("The request body must be empty or a JSON object.", { status: 400 });
  }
  const signed = isQStashSigned(request);
  const finalAttempt = !signed || deliveryAttempt(request, runRetries).final;
  try {
    const result = await deps.runAutomation(new Date(), {}, { manual: !signed, finalAttempt });
    if (result.status === "busy") return busyResponse(result.reason, signed, finalAttempt, deps);
    await deps.pingHeartbeat(true);
    return NextResponse.json(result);
  } catch (error) {
    await deps.pingHeartbeat(false);
    const message = errorMessage(error);
    console.error("LinkedIn automation failed:", message);
    // A rejected draft was already recorded with its attempts; anything else is recorded
    // here. Either way the 500 lets QStash retry with a fresh sample.
    if (!(error instanceof DraftRejectedError)) {
      await deps.recordAutomationRun({ ranAt: new Date().toISOString(), status: "failed", reason: message });
      if (finalAttempt) {
        await deps.notifyOperator({ title: "LinkedIn automation run failed", body: message, priority: 4 });
      }
    }
    return NextResponse.json({ status: "failed", error: message }, { status: 500 });
  }
}

// Another run for the same morning holds the lock. Usually it is alive and about to
// queue the post, so a QStash delivery answers 503 and comes back later, when it finds
// the post queued or the lock free: a 200 here would end the retries, ping the
// heartbeat as healthy and, if the holder had been killed, lose the night in silence.
// The holder pings the heartbeat itself, so this only does so when no retry is left.
async function busyResponse(reason: string, signed: boolean, finalAttempt: boolean, deps: RunRequestDeps) {
  if (!signed) return NextResponse.json({ status: "busy", reason }, { status: 409 });
  console.error("Run deferred:", reason);
  if (finalAttempt) {
    await deps.pingHeartbeat(false);
    await deps.notifyOperator({
      title: "The run could not start",
      body: `${reason} QStash has no retries left, so check the dashboard for tonight's post.`,
      priority: 5,
    });
  }
  return NextResponse.json({ status: "busy", reason }, { status: 503 });
}
