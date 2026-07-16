import { NextResponse } from "next/server";

import { estimateMealNutrition } from "@/lib/openai-estimator";
import type { MealRecord } from "@/lib/schemas";
import { mealInputSchema, trackedNutrientSchema } from "@/lib/schemas";
import {
  deleteMeal,
  downloadMealPhotos,
  getAuthenticatedSupabase,
  getMeal,
  insertMeal,
  listMeals,
  removeMealPhotos,
  replaceMealNutrition,
  uploadMealPhotos,
} from "@/lib/supabase-server";
import { z } from "zod";

export const runtime = "nodejs";

const maxMealPhotos = 6;

function getFileExtension(fileName: string, mimeType: string) {
  const fromName = fileName.split(".").pop();

  if (fromName && fromName !== fileName) {
    return fromName.toLowerCase();
  }

  if (mimeType === "image/png") {
    return "png";
  }

  if (mimeType === "image/webp") {
    return "webp";
  }

  return "jpg";
}

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function needsCardBackfill(meal: Awaited<ReturnType<typeof listMeals>>[number]) {
  return !meal.nutrition.mealTitle || !meal.nutrition.ingredientEstimates?.length;
}

function formatRecentMealContext(meals: MealRecord[]) {
  return meals
    .slice(0, 12)
    .map((meal) => {
      const nutrition = meal.correctedNutrition ?? meal.nutrition;
      const ingredients =
        meal.nutrition.ingredientEstimates
          ?.map((ingredient) => `${ingredient.name}: ${ingredient.amount}`)
          .join("; ") || meal.nutrition.notableIngredients.join("; ");

      return [
        `- ${meal.nutrition.mealTitle || meal.description || "Meal"} (${meal.eatenAt})`,
        `  Description: ${meal.nutrition.cleanedDescription || meal.description}`,
        ingredients ? `  Ingredients: ${ingredients}` : "",
        `  Macros: ${Math.round(nutrition.calories)} cal, ${Math.round(nutrition.proteinGrams)}g protein, ${Math.round(nutrition.carbsGrams)}g carbs, ${Math.round(nutrition.fatGrams)}g fat, ${Math.round(nutrition.fiberGrams)}g fiber`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

function getTrackedNutrients(value: unknown) {
  const parsed = z.array(trackedNutrientSchema).safeParse(value);

  return parsed.success ? parsed.data : [];
}

function formatMealForCorrection(meal: MealRecord, correction: string) {
  const nutrition = meal.correctedNutrition ?? meal.nutrition;
  const ingredients =
    meal.nutrition.ingredientEstimates
      ?.map((ingredient) => `${ingredient.name}: ${ingredient.amount}`)
      .join("\n") || meal.nutrition.notableIngredients.join("\n");
  const macroBreakdown =
    meal.nutrition.macroBreakdown
      ?.map(
        (ingredient) =>
          `${ingredient.name}: ${ingredient.amount}, ${Math.round(ingredient.calories)} cal, ${Math.round(ingredient.proteinGrams)}g protein, ${Math.round(ingredient.carbsGrams)}g carbs, ${Math.round(ingredient.fatGrams)}g fat, ${Math.round(ingredient.fiberGrams)}g fiber`,
      )
      .join("\n") || "";

  return [
    "The user is correcting an existing meal entry. Apply the correction to the current structured meal data and return a complete updated estimate.",
    "Keep facts from the current meal unless the correction changes them. Recompute ingredients, per-ingredient macro breakdown, and total macros from the corrected facts.",
    "If the correction changes when the meal was eaten, return inferredMealTime for the corrected time; otherwise keep inferredMealTime null.",
    "",
    `User correction: ${correction}`,
    "",
    `Current title: ${meal.nutrition.mealTitle || meal.description || "Meal"}`,
    `Current eatenAt: ${meal.eatenAt}`,
    `Current original description: ${meal.description}`,
    `Current cleaned description: ${meal.nutrition.cleanedDescription || meal.description}`,
    ingredients ? `Current ingredients:\n${ingredients}` : "",
    `Current totals: ${Math.round(nutrition.calories)} cal, ${Math.round(nutrition.proteinGrams)}g protein, ${Math.round(nutrition.carbsGrams)}g carbs, ${Math.round(nutrition.fatGrams)}g fat, ${Math.round(nutrition.fiberGrams)}g fiber`,
    macroBreakdown ? `Current macro breakdown:\n${macroBreakdown}` : "",
    meal.correctionNote ? `Previous correction note: ${meal.correctionNote}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function getNextCorrectionNote(existingNote: string | undefined, correction: string) {
  const nextLine = `${new Date().toISOString()}: ${correction}`;

  return existingNote ? `${existingNote}\n${nextLine}` : nextLine;
}

const mealUpdateSchema = z.object({
  correction: z.string().trim().min(1, "Add a correction before saving."),
  id: z.string().uuid(),
  timezone: z.string().optional(),
});

const mealDeleteSchema = z.object({
  id: z.string().uuid(),
});

export async function GET(request: Request) {
  const auth = await getAuthenticatedSupabase(request);

  if (!auth) {
    return jsonError("Sign in before loading meals.", 401);
  }

  const shouldBackfill =
    new URL(request.url).searchParams.get("backfillMissing") === "1";
  let meals = await listMeals(auth.supabase, auth.user.id);

  if (shouldBackfill) {
    const missingCardData = meals.filter(needsCardBackfill);

    for (const meal of missingCardData) {
      const images = await downloadMealPhotos(auth.supabase, meal.photos);
      const nutrition = await estimateMealNutrition({
        description: meal.description,
        images,
        restaurantLink: meal.restaurantLink,
        submittedAt: meal.createdAt,
      });

      await replaceMealNutrition({
        id: meal.id,
        nutrition,
        supabase: auth.supabase,
        userId: auth.user.id,
      });
    }

    if (missingCardData.length > 0) {
      meals = await listMeals(auth.supabase, auth.user.id);
    }
  }

  return NextResponse.json({ meals });
}

export async function POST(request: Request) {
  const auth = await getAuthenticatedSupabase(request);

  if (!auth) {
    return jsonError("Sign in before logging a meal.", 401);
  }

  const formData = await request.formData();
  const photos = [...formData.getAll("photos"), ...formData.getAll("photo")].filter(
    (value): value is File => value instanceof File && value.size > 0,
  );

  if (photos.length > maxMealPhotos) {
    return jsonError(`Add no more than ${maxMealPhotos} images per meal.`);
  }

  if (photos.some((photo) => photo.type && !photo.type.startsWith("image/"))) {
    return jsonError("Meal uploads must be image files.");
  }

  const input = mealInputSchema.safeParse({
    description: formData.get("description") || undefined,
    eatenAt: formData.get("eatenAt") || undefined,
    restaurantLink: formData.get("restaurantLink") || undefined,
  });

  if (!input.success) {
    return jsonError(input.error.issues[0]?.message ?? "Invalid meal input.");
  }

  const description = input.data.description ?? "";

  if (!description && !photos.length) {
    return jsonError("Add a meal note or image before saving.");
  }

  const id = crypto.randomUUID();
  const submittedAt = new Date().toISOString();
  const pendingPhotos = await Promise.all(
    photos.map(async (photo, index) => {
      const mimeType = photo.type || "image/jpeg";

      return {
        bytes: Buffer.from(await photo.arrayBuffer()),
        fileName: `${id}-${index + 1}.${getFileExtension(photo.name, mimeType)}`,
        mimeType,
      };
    }),
  );
  const recentMealContext = formatRecentMealContext(
    await listMeals(auth.supabase, auth.user.id),
  );
  const trackedNutrients = getTrackedNutrients(
    auth.user.user_metadata?.trackedNutrients,
  );
  const nutrition = await estimateMealNutrition({
    description,
    images: pendingPhotos.map(({ bytes, mimeType }) => ({ bytes, mimeType })),
    recentMealContext,
    restaurantLink: input.data.restaurantLink,
    submittedAt,
    timezone:
      typeof formData.get("timezone") === "string"
        ? (formData.get("timezone") as string)
        : undefined,
    trackedNutrients,
  });
  const eatenAt = nutrition.inferredMealTime ?? input.data.eatenAt ?? submittedAt;
  const datePath = eatenAt.slice(0, 10);
  const uploadedPhotos = await uploadMealPhotos({
    pathDate: datePath,
    photos: pendingPhotos,
    supabase: auth.supabase,
    userId: auth.user.id,
  });
  let meal: MealRecord;

  try {
    meal = await insertMeal({
      description: description || nutrition.cleanedDescription || "Image-only meal",
      eatenAt,
      id,
      nutrition,
      photos: uploadedPhotos,
      restaurantLink: input.data.restaurantLink,
      supabase: auth.supabase,
      userId: auth.user.id,
    });
  } catch (error) {
    await removeMealPhotos(
      auth.supabase,
      uploadedPhotos.map((photo) => photo.fileId),
    ).catch(() => undefined);
    throw error;
  }

  return NextResponse.json({ meal }, { status: 201 });
}

export async function PATCH(request: Request) {
  const auth = await getAuthenticatedSupabase(request);

  if (!auth) {
    return jsonError("Sign in before editing a meal.", 401);
  }

  const input = mealUpdateSchema.safeParse(await request.json());

  if (!input.success) {
    return jsonError(input.error.issues[0]?.message ?? "Invalid meal update.");
  }

  const existingMeal = await getMeal(auth.supabase, auth.user.id, input.data.id);
  const images = await downloadMealPhotos(auth.supabase, existingMeal.photos);
  const nutrition = await estimateMealNutrition({
    description: formatMealForCorrection(existingMeal, input.data.correction),
    images,
    restaurantLink: existingMeal.restaurantLink,
    submittedAt: existingMeal.createdAt,
    timezone: input.data.timezone,
    trackedNutrients: getTrackedNutrients(
      auth.user.user_metadata?.trackedNutrients,
    ),
  });
  const meal = await replaceMealNutrition({
    correctionNote: getNextCorrectionNote(
      existingMeal.correctionNote,
      input.data.correction,
    ),
    eatenAt: nutrition.inferredMealTime ?? undefined,
    id: input.data.id,
    nutrition,
    supabase: auth.supabase,
    userId: auth.user.id,
  });

  return NextResponse.json({ meal });
}

export async function DELETE(request: Request) {
  const auth = await getAuthenticatedSupabase(request);

  if (!auth) {
    return jsonError("Sign in before deleting a meal.", 401);
  }

  const input = mealDeleteSchema.safeParse(await request.json());

  if (!input.success) {
    return jsonError(input.error.issues[0]?.message ?? "Invalid meal id.");
  }

  await deleteMeal({
    id: input.data.id,
    supabase: auth.supabase,
    userId: auth.user.id,
  });

  return NextResponse.json({ ok: true });
}
