import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listPosts, updatePost } from "@/lib/storage/posts";
import { publishTextPost } from "@/lib/linkedin/api";
import { connectUrl } from "@/lib/linkedin/oauth";
import { notifyOperator } from "@/lib/notify/ntfy";
import { authorizeQStashRequest } from "@/lib/security/request-auth";
import { formatDateTime } from "@/lib/scheduling/time";
import { errorMessage } from "@/lib/errors";

export const maxDuration = 60;

const requestSchema = z.object({ postId: z.string().min(1) });

function parsePostId(body: string) {
  try {
    return requestSchema.parse(JSON.parse(body)).postId;
  } catch {
    return undefined;
  }
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  if (!(await authorizeQStashRequest(request, body))) return new NextResponse("Unauthorized", { status: 401 });
  const postId = parsePostId(body);
  if (!postId) return new NextResponse("Missing post id", { status: 400 });
  const due = (await listPosts()).find((post) => post.id === postId && post.status === "queued");
  if (!due) return NextResponse.json({ published: false, message: "Post was already handled." });
  try {
    due.linkedinPostId = await publishTextPost(due.text);
  } catch (error) {
    // Stay queued so QStash can retry. The next automation run retires it if every
    // attempt failed, which is what stops a dead token from looking like pending work.
    due.error = errorMessage(error);
    await updatePost(due);
    const attempt = Number(request.headers.get("upstash-retried") ?? 0) + 1;
    await notifyOperator({
      title: `LinkedIn publish failed (attempt ${attempt})`,
      body: `${due.error} The post scheduled for ${formatDateTime(due.scheduledFor)} is still queued${attempt < 4 ? " and QStash will retry" : " and QStash has given up"}.`,
      priority: attempt < 4 ? 3 : 5,
      link: /authoriz/i.test(due.error) ? connectUrl() : undefined,
    });
    return NextResponse.json({ published: false, id: due.id, error: due.error }, { status: 502 });
  }
  // LinkedIn has the post now. Whatever happens to the bookkeeping, this delivery must
  // answer 2xx, or the retry would publish the same text again.
  due.status = "posted";
  due.postedAt = new Date().toISOString();
  due.error = undefined;
  try {
    await updatePost(due);
  } catch (error) {
    console.error("Post published but its record could not be updated:", errorMessage(error));
    return NextResponse.json({ published: true, id: due.id, linkedinPostId: due.linkedinPostId, persisted: false });
  }
  return NextResponse.json({ published: true, id: due.id, linkedinPostId: due.linkedinPostId });
}
