import { NextResponse } from "next/server";
import { z } from "zod";

import { estimateMealNutrition } from "@/lib/openai-estimator";
import {
  downloadMealPhoto,
  getAuthenticatedSupabase,
  getMeal,
  replaceMealNutrition,
} from "@/lib/supabase-server";

export const runtime = "nodejs";

const regenerateSchema = z.object({
  id: z.string().uuid(),
  timezone: z.string().optional(),
});

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function getMimeType(fileName?: string) {
  if (fileName?.toLowerCase().endsWith(".png")) {
    return "image/png";
  }

  if (fileName?.toLowerCase().endsWith(".webp")) {
    return "image/webp";
  }

  return "image/jpeg";
}

export async function POST(request: Request) {
  const auth = await getAuthenticatedSupabase(request);

  if (!auth) {
    return jsonError("Sign in before regenerating a meal.", 401);
  }

  const input = regenerateSchema.safeParse(await request.json());

  if (!input.success) {
    return jsonError(input.error.issues[0]?.message ?? "Invalid meal id.");
  }

  const existingMeal = await getMeal(auth.supabase, auth.user.id, input.data.id);
  const imageBytes = existingMeal.photoFileId
    ? await downloadMealPhoto(auth.supabase, existingMeal.photoFileId)
    : undefined;
  const nutrition = await estimateMealNutrition({
    description: existingMeal.description,
    imageBytes,
    mimeType: imageBytes ? getMimeType(existingMeal.photoFileName) : undefined,
    restaurantLink: existingMeal.restaurantLink,
    submittedAt: existingMeal.createdAt,
    timezone: input.data.timezone,
  });
  const meal = await replaceMealNutrition({
    id: existingMeal.id,
    nutrition,
    supabase: auth.supabase,
    userId: auth.user.id,
  });

  return NextResponse.json({ meal });
}
