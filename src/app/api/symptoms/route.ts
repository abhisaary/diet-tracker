import { NextResponse } from "next/server";

import { symptomInputSchema } from "@/lib/schemas";
import {
  getAuthenticatedSupabase,
  insertSymptom,
  listSymptoms,
} from "@/lib/supabase-server";

export const runtime = "nodejs";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  const auth = await getAuthenticatedSupabase(request);

  if (!auth) {
    return jsonError("Sign in before loading symptoms.", 401);
  }

  const symptoms = await listSymptoms(auth.supabase, auth.user.id);

  return NextResponse.json({ symptoms });
}

export async function POST(request: Request) {
  const auth = await getAuthenticatedSupabase(request);

  if (!auth) {
    return jsonError("Sign in before logging symptoms.", 401);
  }

  const formData = await request.formData();
  const input = symptomInputSchema.safeParse({
    durationMinutes: formData.get("durationMinutes") || undefined,
    note: formData.get("note"),
    occurredAt: formData.get("occurredAt") || undefined,
    severity: formData.get("severity") || undefined,
    tags: formData.get("tags") || undefined,
  });

  if (!input.success) {
    return jsonError(input.error.issues[0]?.message ?? "Invalid symptom input.");
  }

  const occurredAt = input.data.occurredAt ?? new Date().toISOString();
  const id = crypto.randomUUID();
  const symptom = await insertSymptom({
    durationMinutes: input.data.durationMinutes,
    id,
    note: input.data.note,
    occurredAt,
    severity: input.data.severity,
    supabase: auth.supabase,
    tags: input.data.tags,
    userId: auth.user.id,
  });

  return NextResponse.json({ symptom }, { status: 201 });
}
