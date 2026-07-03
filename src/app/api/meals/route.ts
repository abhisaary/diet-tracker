import { NextResponse } from "next/server";

import { estimateMealNutrition } from "@/lib/openai-estimator";
import type { MealRecord } from "@/lib/schemas";
import { macroSchema, mealInputSchema } from "@/lib/schemas";
import {
  deleteMeal,
  downloadMealPhoto,
  getAuthenticatedSupabase,
  getMeal,
  insertMeal,
  listMeals,
  replaceMealNutrition,
  updateMeal,
  uploadMealPhoto,
} from "@/lib/supabase-server";
import { z } from "zod";

export const runtime = "nodejs";

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

function getMimeType(fileName?: string) {
  if (fileName?.toLowerCase().endsWith(".png")) {
    return "image/png";
  }

  if (fileName?.toLowerCase().endsWith(".webp")) {
    return "image/webp";
  }

  return "image/jpeg";
}

function needsCardBackfill(meal: Awaited<ReturnType<typeof listMeals>>[number]) {
  return !meal.nutrition.mealTitle || !meal.nutrition.ingredientEstimates?.length;
}

function getEditedMealDescription({
  cleanedDescription,
  ingredientEstimates,
  mealTitle,
}: {
  cleanedDescription: string;
  ingredientEstimates: { amount: string; name: string }[];
  mealTitle: string;
}) {
  const ingredients = ingredientEstimates
    .map((ingredient) => `${ingredient.name}: ${ingredient.amount}`)
    .join("\n");

  return [
    "The user corrected an existing meal entry. Re-estimate the full nutrition from the corrected card data below.",
    `Meal title: ${mealTitle}`,
    `Description: ${cleanedDescription}`,
    ingredients ? `Ingredients:\n${ingredients}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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

const mealUpdateSchema = z.object({
  cleanedDescription: z.string().trim().min(1),
  eatenAt: z.string().datetime().optional(),
  id: z.string().uuid(),
  ingredientEstimates: z.array(
    z.object({
      amount: z.string(),
      name: z.string(),
    }),
  ),
  mealTitle: z.string().trim().min(1),
  nutrition: macroSchema,
  regenerateNutrition: z.boolean().default(false),
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
      const imageBytes = meal.photoFileId
        ? await downloadMealPhoto(auth.supabase, meal.photoFileId)
        : undefined;
      const nutrition = await estimateMealNutrition({
        description: meal.description,
        imageBytes,
        mimeType: imageBytes ? getMimeType(meal.photoFileName) : undefined,
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
  const photo = formData.get("photo");
  const hasPhoto = photo instanceof File && photo.size > 0;

  const input = mealInputSchema.safeParse({
    description: formData.get("description") || undefined,
    eatenAt: formData.get("eatenAt") || undefined,
    restaurantLink: formData.get("restaurantLink") || undefined,
  });

  if (!input.success) {
    return jsonError(input.error.issues[0]?.message ?? "Invalid meal input.");
  }

  const description = input.data.description ?? "";

  if (!description && !hasPhoto) {
    return jsonError("Add a meal note or image before saving.");
  }

  const id = crypto.randomUUID();
  const submittedAt = new Date().toISOString();
  const imageBytes = hasPhoto
    ? Buffer.from(await photo.arrayBuffer())
    : undefined;
  const mimeType = hasPhoto ? photo.type || "image/jpeg" : undefined;
  const photoFileName =
    hasPhoto && mimeType ? `${id}.${getFileExtension(photo.name, mimeType)}` : undefined;
  const recentMealContext = formatRecentMealContext(
    await listMeals(auth.supabase, auth.user.id),
  );
  const nutrition = await estimateMealNutrition({
    description,
    imageBytes,
    mimeType,
    recentMealContext,
    restaurantLink: input.data.restaurantLink,
    submittedAt,
    timezone:
      typeof formData.get("timezone") === "string"
        ? (formData.get("timezone") as string)
        : undefined,
  });
  const eatenAt = nutrition.inferredMealTime ?? input.data.eatenAt ?? submittedAt;
  const datePath = eatenAt.slice(0, 10);
  const photoPath =
    imageBytes && mimeType && photoFileName
      ? await uploadMealPhoto({
          bytes: imageBytes,
          fileName: photoFileName,
          mimeType,
          pathDate: datePath,
          supabase: auth.supabase,
          userId: auth.user.id,
        })
      : undefined;
  const meal = await insertMeal({
    description: description || nutrition.cleanedDescription || "Image-only meal",
    eatenAt,
    id,
    nutrition,
    photoFileName,
    photoPath,
    restaurantLink: input.data.restaurantLink,
    supabase: auth.supabase,
    userId: auth.user.id,
  });

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

  if (input.data.regenerateNutrition) {
    const existingMeal = await getMeal(auth.supabase, auth.user.id, input.data.id);
    const imageBytes = existingMeal.photoFileId
      ? await downloadMealPhoto(auth.supabase, existingMeal.photoFileId)
      : undefined;
    const nutrition = await estimateMealNutrition({
      description: getEditedMealDescription({
        cleanedDescription: input.data.cleanedDescription,
        ingredientEstimates: input.data.ingredientEstimates,
        mealTitle: input.data.mealTitle,
      }),
      imageBytes,
      mimeType: imageBytes ? getMimeType(existingMeal.photoFileName) : undefined,
      restaurantLink: existingMeal.restaurantLink,
      submittedAt: existingMeal.createdAt,
      timezone: input.data.timezone,
    });
    const meal = await replaceMealNutrition({
      eatenAt: input.data.eatenAt,
      id: input.data.id,
      nutrition: {
        ...nutrition,
        inferredMealTime: input.data.eatenAt ?? nutrition.inferredMealTime,
        mealTitle: input.data.mealTitle || nutrition.mealTitle,
      },
      supabase: auth.supabase,
      userId: auth.user.id,
    });

    return NextResponse.json({ meal });
  }

  const meal = await updateMeal({
    cleanedDescription: input.data.cleanedDescription,
    correctedNutrition: input.data.nutrition,
    eatenAt: input.data.eatenAt,
    id: input.data.id,
    ingredientEstimates: input.data.ingredientEstimates,
    mealTitle: input.data.mealTitle,
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
