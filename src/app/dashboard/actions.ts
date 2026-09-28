"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { authorizeDashboard } from "@/lib/security/dashboard-auth";
import { qstash } from "@/lib/scheduling/qstash";
import { editAction, rejectAction, runNowAction, type ActionDeps } from "./action-handlers";

const deps: ActionDeps = {
  authorized: async () => authorizeDashboard((await headers()).get("authorization")),
  publisher: qstash,
  revalidate: () => revalidatePath("/dashboard"),
};

export async function runNow() {
  return runNowAction(deps);
}

export async function rejectPost(formData: FormData) {
  return rejectAction(formData, deps);
}

export async function editPost(formData: FormData) {
  return editAction(formData, deps);
}
