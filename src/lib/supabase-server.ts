import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

import { getEnv, getOptionalEnv } from "@/lib/env";
import {
  macroSchema,
  mealRecordSchema,
  nutritionEstimateSchema,
  symptomRecordSchema,
} from "@/lib/schemas";
import type { MealRecord, NutritionEstimate, SymptomRecord } from "@/lib/schemas";

type MealRow = {
  id: string;
  user_id: string;
  eaten_at: string;
  created_at: string;
  description: string;
  restaurant_link: string | null;
  photo_path: string | null;
  photo_file_name: string | null;
  photo_paths?: string[] | null;
  photo_file_names?: string[] | null;
  nutrition: unknown;
  corrected_nutrition: unknown | null;
  correction_note: string | null;
};

type SymptomRow = {
  id: string;
  user_id: string;
  occurred_at: string;
  created_at: string;
  severity: number;
  duration_minutes: number | null;
  tags: string[];
  note: string;
};

type AuthenticatedSupabase = {
  supabase: SupabaseClient;
  user: User;
};

const mealPhotosBucket = "meal-photos";

function toIsoString(value: string) {
  return new Date(value).toISOString();
}

function getMealPhotoMimeType(fileName?: string) {
  if (fileName?.toLowerCase().endsWith(".png")) {
    return "image/png";
  }

  if (fileName?.toLowerCase().endsWith(".webp")) {
    return "image/webp";
  }

  if (fileName?.toLowerCase().endsWith(".gif")) {
    return "image/gif";
  }

  return "image/jpeg";
}

export function createServerSupabaseClient(accessToken?: string) {
  return createClient(
    getEnv("NEXT_PUBLIC_SUPABASE_URL"),
    getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    accessToken
      ? {
          global: {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          },
        }
      : undefined,
  );
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length);
}

function getAllowedEmails() {
  return [
    ...(getOptionalEnv("APP_ALLOWED_EMAILS") ?? "").split(","),
    getOptionalEnv("APP_ALLOWED_EMAIL") ?? "",
  ]
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export async function getAuthenticatedSupabase(
  request: Request,
): Promise<AuthenticatedSupabase | null> {
  const accessToken = getBearerToken(request);

  if (!accessToken) {
    return null;
  }

  const supabase = createServerSupabaseClient(accessToken);
  const { data, error } = await supabase.auth.getUser(accessToken);

  if (error || !data.user) {
    return null;
  }

  const allowedEmails = getAllowedEmails();
  const userEmail = data.user.email?.toLowerCase();

  if (!userEmail || !allowedEmails.includes(userEmail)) {
    return null;
  }

  return { supabase, user: data.user };
}

function toMealRecord(row: MealRow): MealRecord {
  const paths =
    row.photo_paths?.length
      ? row.photo_paths
      : row.photo_path
        ? [row.photo_path]
        : [];
  const fileNames =
    row.photo_file_names?.length
      ? row.photo_file_names
      : row.photo_file_name
        ? [row.photo_file_name]
        : [];
  const photos = paths.map((fileId, index) => ({
    fileId,
    fileName: fileNames[index] || (index === 0 ? row.photo_file_name ?? undefined : undefined),
  }));

  return mealRecordSchema.parse({
    correctedNutrition: row.corrected_nutrition
      ? macroSchema.parse(row.corrected_nutrition)
      : undefined,
    correctionNote: row.correction_note ?? undefined,
    createdAt: toIsoString(row.created_at),
    description: row.description,
    eatenAt: toIsoString(row.eaten_at),
    id: row.id,
    nutrition: nutritionEstimateSchema.parse(row.nutrition),
    photos,
    photoFileId: photos[0]?.fileId,
    photoFileName: photos[0]?.fileName,
    restaurantLink: row.restaurant_link ?? undefined,
    type: "meal",
  });
}

function toSymptomRecord(row: SymptomRow): SymptomRecord {
  return symptomRecordSchema.parse({
    createdAt: toIsoString(row.created_at),
    durationMinutes: row.duration_minutes ?? undefined,
    id: row.id,
    note: row.note,
    occurredAt: toIsoString(row.occurred_at),
    severity: row.severity,
    tags: row.tags,
    type: "symptom",
  });
}

export async function listMeals(
  supabase: SupabaseClient,
  userId: string,
): Promise<MealRecord[]> {
  const { data, error } = await supabase
    .from("meals")
    .select("*")
    .eq("user_id", userId)
    .order("eaten_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as MealRow[]).map(toMealRecord);
}

export async function getMeal(
  supabase: SupabaseClient,
  userId: string,
  mealId: string,
): Promise<MealRecord> {
  const { data, error } = await supabase
    .from("meals")
    .select("*")
    .eq("id", mealId)
    .eq("user_id", userId)
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return toMealRecord(data as MealRow);
}

export async function downloadMealPhoto(
  supabase: SupabaseClient,
  path: string,
) {
  const { data, error } = await supabase.storage
    .from(mealPhotosBucket)
    .download(path);

  if (error) {
    throw new Error(error.message);
  }

  return Buffer.from(await data.arrayBuffer());
}

export async function downloadMealPhotos(
  supabase: SupabaseClient,
  photos: MealRecord["photos"],
) {
  return Promise.all(
    photos.map(async (photo) => ({
      bytes: await downloadMealPhoto(supabase, photo.fileId),
      mimeType: getMealPhotoMimeType(photo.fileName),
    })),
  );
}

export async function listSymptoms(
  supabase: SupabaseClient,
  userId: string,
): Promise<SymptomRecord[]> {
  const { data, error } = await supabase
    .from("symptoms")
    .select("*")
    .eq("user_id", userId)
    .order("occurred_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as SymptomRow[]).map(toSymptomRecord);
}

export async function uploadMealPhoto({
  bytes,
  fileName,
  mimeType,
  pathDate,
  supabase,
  userId,
}: {
  bytes: Buffer;
  fileName: string;
  mimeType: string;
  pathDate: string;
  supabase: SupabaseClient;
  userId: string;
}) {
  const path = `${userId}/${pathDate}/${fileName}`;
  const { error } = await supabase.storage
    .from(mealPhotosBucket)
    .upload(path, bytes, {
      contentType: mimeType,
      upsert: false,
    });

  if (error) {
    throw new Error(error.message);
  }

  return path;
}

export async function removeMealPhotos(
  supabase: SupabaseClient,
  paths: string[],
) {
  if (!paths.length) {
    return;
  }

  const { error } = await supabase.storage.from(mealPhotosBucket).remove(paths);

  if (error) {
    throw new Error(error.message);
  }
}

export async function uploadMealPhotos({
  pathDate,
  photos,
  supabase,
  userId,
}: {
  pathDate: string;
  photos: { bytes: Buffer; fileName: string; mimeType: string }[];
  supabase: SupabaseClient;
  userId: string;
}) {
  const uploadedPhotos: { fileId: string; fileName: string }[] = [];

  try {
    for (const photo of photos) {
      const fileId = await uploadMealPhoto({
        bytes: photo.bytes,
        fileName: photo.fileName,
        mimeType: photo.mimeType,
        pathDate,
        supabase,
        userId,
      });
      uploadedPhotos.push({ fileId, fileName: photo.fileName });
    }
  } catch (error) {
    await removeMealPhotos(
      supabase,
      uploadedPhotos.map((photo) => photo.fileId),
    ).catch(() => undefined);
    throw error;
  }

  return uploadedPhotos;
}

export async function insertMeal({
  correctedNutrition,
  correctionNote,
  description,
  eatenAt,
  id,
  nutrition,
  photos = [],
  restaurantLink,
  supabase,
  userId,
}: {
  correctedNutrition?: MealRecord["correctedNutrition"];
  correctionNote?: string;
  description: string;
  eatenAt: string;
  id: string;
  nutrition: NutritionEstimate;
  photos?: { fileId: string; fileName: string }[];
  restaurantLink?: string;
  supabase: SupabaseClient;
  userId: string;
}) {
  const { data, error } = await supabase
    .from("meals")
    .insert({
      corrected_nutrition: correctedNutrition ?? null,
      correction_note: correctionNote ?? null,
      description,
      eaten_at: eatenAt,
      id,
      nutrition,
      photo_file_name: photos[0]?.fileName ?? null,
      photo_file_names: photos.map((photo) => photo.fileName),
      photo_path: photos[0]?.fileId ?? null,
      photo_paths: photos.map((photo) => photo.fileId),
      restaurant_link: restaurantLink ?? null,
      user_id: userId,
    })
    .select("*")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return toMealRecord(data as MealRow);
}

export async function updateMeal({
  cleanedDescription,
  correctedNutrition,
  eatenAt,
  id,
  ingredientEstimates,
  mealTitle,
  supabase,
  userId,
}: {
  cleanedDescription: string;
  correctedNutrition: MealRecord["correctedNutrition"];
  eatenAt?: string;
  id: string;
  ingredientEstimates: NonNullable<NutritionEstimate["ingredientEstimates"]>;
  mealTitle: string;
  supabase: SupabaseClient;
  userId: string;
}) {
  const { data: existing, error: readError } = await supabase
    .from("meals")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .single();

  if (readError) {
    throw new Error(readError.message);
  }

  const existingMeal = toMealRecord(existing as MealRow);
  const nutrition: NutritionEstimate = {
    ...existingMeal.nutrition,
    ...correctedNutrition,
    cleanedDescription,
    ingredientEstimates,
    inferredMealTime: eatenAt ?? existingMeal.nutrition.inferredMealTime,
    mealTitle,
    notableIngredients: ingredientEstimates.map((ingredient) => ingredient.name),
  };

  const { data, error } = await supabase
    .from("meals")
    .update({
      corrected_nutrition: correctedNutrition,
      eaten_at: eatenAt ?? existingMeal.eatenAt,
      nutrition,
    })
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return toMealRecord(data as MealRow);
}

export async function replaceMealNutrition({
  correctionNote,
  eatenAt,
  id,
  nutrition,
  supabase,
  userId,
}: {
  correctionNote?: string;
  eatenAt?: string;
  id: string;
  nutrition: NutritionEstimate;
  supabase: SupabaseClient;
  userId: string;
}) {
  const { data, error } = await supabase
    .from("meals")
    .update({
      correction_note: correctionNote ?? null,
      corrected_nutrition: null,
      ...(eatenAt ? { eaten_at: eatenAt } : {}),
      nutrition,
    })
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return toMealRecord(data as MealRow);
}

export async function deleteMeal({
  id,
  supabase,
  userId,
}: {
  id: string;
  supabase: SupabaseClient;
  userId: string;
}) {
  const existingMeal = await getMeal(supabase, userId, id);

  const { data, error } = await supabase
    .from("meals")
    .delete()
    .eq("id", id)
    .eq("user_id", userId)
    .select("id");

  if (error) {
    throw new Error(error.message);
  }

  if (!data?.length) {
    throw new Error("Meal was not deleted. Check the Supabase delete policy.");
  }

  await removeMealPhotos(
    supabase,
    existingMeal.photos.map((photo) => photo.fileId),
  ).catch(() => undefined);
}

export async function insertSymptom({
  durationMinutes,
  id,
  note,
  occurredAt,
  severity,
  supabase,
  tags,
  userId,
}: {
  durationMinutes?: number;
  id: string;
  note: string;
  occurredAt: string;
  severity: number;
  supabase: SupabaseClient;
  tags: string[];
  userId: string;
}) {
  const { data, error } = await supabase
    .from("symptoms")
    .insert({
      duration_minutes: durationMinutes ?? null,
      id,
      note,
      occurred_at: occurredAt,
      severity,
      tags,
      user_id: userId,
    })
    .select("*")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return toSymptomRecord(data as SymptomRow);
}
