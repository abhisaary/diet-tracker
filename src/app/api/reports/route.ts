import { NextResponse } from "next/server";

import { buildReportSummary } from "@/lib/reports";
import {
  getAuthenticatedSupabase,
  listMeals,
  listSymptoms,
} from "@/lib/supabase-server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await getAuthenticatedSupabase(request);

  if (!auth) {
    return NextResponse.json(
      { error: "Sign in before loading reports." },
      { status: 401 },
    );
  }

  const [meals, symptoms] = await Promise.all([
    listMeals(auth.supabase, auth.user.id),
    listSymptoms(auth.supabase, auth.user.id),
  ]);

  return NextResponse.json(buildReportSummary(meals, symptoms));
}
