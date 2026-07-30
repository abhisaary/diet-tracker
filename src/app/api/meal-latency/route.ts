import { NextResponse } from "next/server";
import { z } from "zod";

import {
  attachClientMealLatency,
  getAuthenticatedSupabase,
} from "@/lib/supabase-server";

export const runtime = "nodejs";

const clientMealLatencySchema = z.object({
  mealId: z.string().uuid().optional(),
  metadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
  operation: z.enum(["create", "edit"]),
  outcome: z.enum(["success", "error"]),
  requestId: z.string().uuid(),
  stages: z.record(z.string(), z.union([z.number(), z.array(z.number())])),
  totalMs: z.number().nonnegative(),
});

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const auth = await getAuthenticatedSupabase(request);

  if (!auth) {
    return jsonError("Sign in before recording meal latency.", 401);
  }

  const body = await request.json().catch(() => null);
  const input = clientMealLatencySchema.safeParse(body);

  if (!input.success) {
    return jsonError(input.error.issues[0]?.message ?? "Invalid latency payload.");
  }

  const metadata = { ...(input.data.metadata ?? {}) };
  delete metadata.requestId;
  delete metadata.serverTiming;

  try {
    await attachClientMealLatency({
      clientStages: input.data.stages,
      clientTotalMs: input.data.totalMs,
      mealId: input.data.mealId,
      metadata,
      operation: input.data.operation,
      outcome: input.data.outcome,
      requestId: input.data.requestId,
      supabase: auth.supabase,
      userId: auth.user.id,
    });
  } catch (error) {
    console.error("[meal-latency-client-persist]", error);
    return jsonError(
      error instanceof Error ? error.message : "Could not save meal latency.",
      500,
    );
  }

  return NextResponse.json({ ok: true });
}
