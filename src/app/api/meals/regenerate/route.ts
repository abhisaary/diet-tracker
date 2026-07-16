import { NextResponse } from "next/server";
import { z } from "zod";

import {
  estimateMealNutrition,
  estimateMealPlantVarieties,
} from "@/lib/openai-estimator";
import { CURRENT_PLANT_VARIETY_VERSION } from "@/lib/plant-variety-rules";
import {
  downloadMealPhotos,
  getAuthenticatedSupabase,
  getMeal,
  listMeals,
  replaceMealNutrition,
  updateMealPlantVarieties,
} from "@/lib/supabase-server";

export const runtime = "nodejs";

const regenerateSchema = z.object({
  id: z.string().uuid(),
  timezone: z.string().optional(),
});

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
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
  const images = await downloadMealPhotos(auth.supabase, existingMeal.photos);
  const nutrition = await estimateMealNutrition({
    description: existingMeal.description,
    images,
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

export async function PUT(request: Request) {
  const auth = await getAuthenticatedSupabase(request);

  if (!auth) {
    return jsonError("Sign in before backfilling meals.", 401);
  }

  const meals = await listMeals(auth.supabase, auth.user.id);
  const missingMeals = meals.filter(
    (meal) =>
      meal.nutrition.plantVarietyVersion !== CURRENT_PLANT_VARIETY_VERSION,
  );
  const batch = missingMeals.slice(0, 12);

  if (batch.length === 0) {
    return NextResponse.json({ processed: 0, remaining: 0 });
  }

  const estimates = await estimateMealPlantVarieties(batch);
  const estimatesById = new Map(
    estimates.map((estimate) => [estimate.id, estimate.plantVarieties]),
  );
  const updatedMeals = (
    await Promise.all(
      batch.map(async (meal) => {
        const plantVarieties = estimatesById.get(meal.id);

        if (!plantVarieties) {
          return null;
        }

        return updateMealPlantVarieties({
          meal,
          plantVarieties,
          supabase: auth.supabase,
          userId: auth.user.id,
        });
      }),
    )
  ).filter((meal) => meal !== null);

  return NextResponse.json({
    processed: updatedMeals.length,
    remaining: missingMeals.length - updatedMeals.length,
  });
}
