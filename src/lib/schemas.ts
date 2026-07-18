import { z } from "zod";

import { PLANT_VARIETY_CATEGORIES } from "@/lib/plant-variety-rules";

const optionalUrlSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim().length === 0 ? undefined : value,
  z.string().trim().url().optional(),
);

export const macroSchema = z.object({
  calories: z.number().nonnegative(),
  proteinGrams: z.number().nonnegative(),
  carbsGrams: z.number().nonnegative(),
  fatGrams: z.number().nonnegative(),
  fiberGrams: z.number().nonnegative(),
});

const ingredientEstimateSchema = z.object({
  amount: z.string(),
  name: z.string(),
});

export const mealPhotoSchema = z.object({
  fileId: z.string(),
  fileName: z.string().optional(),
});

export const trackedNutrientSchema = z.object({
  name: z.string().trim().min(1),
  unit: z.string().trim().min(1),
});

const customNutrientEstimateSchema = trackedNutrientSchema.extend({
  amount: z.number().nonnegative(),
  confidence: z.enum(["low", "medium", "high"]),
});

const ingredientMacroEstimateSchema = ingredientEstimateSchema.extend({
  calories: z.number().nonnegative(),
  proteinGrams: z.number().nonnegative(),
  carbsGrams: z.number().nonnegative(),
  fatGrams: z.number().nonnegative(),
  fiberGrams: z.number().nonnegative(),
  macroBasis: z.string(),
  customNutrients: z.array(customNutrientEstimateSchema).optional(),
});

const mealCautionSchema = z.object({
  description: z.string(),
  ingredients: z.array(z.string()),
  label: z.string(),
});

const plantVarietySchema = z.object({
  category: z.enum(PLANT_VARIETY_CATEGORIES),
  name: z.string(),
});

export const nutritionEstimateSchema = macroSchema.extend({
  calculationSummary: z.string().optional(),
  cleanedDescription: z.string().optional(),
  confidence: z.enum(["low", "medium", "high"]),
  cautions: z.array(mealCautionSchema).optional(),
  customNutrients: z.array(customNutrientEstimateSchema).optional(),
  estimatedPortion: z.string(),
  ingredientEstimates: z.array(ingredientEstimateSchema).optional(),
  inferredMealTime: z.string().datetime().nullable(),
  macroBreakdown: z.array(ingredientMacroEstimateSchema).optional(),
  mealTitle: z.string().optional(),
  notableIngredients: z.array(z.string()),
  plantVarieties: z.array(plantVarietySchema).optional(),
  plantVarietyVersion: z.number().int().positive().optional(),
  possibleTriggers: z.array(z.string()),
  sanityCheck: z.string().optional(),
  assumptions: z.array(z.string()),
  model: z.string(),
  estimatedAt: z.string().datetime(),
});

export const mealRecordSchema = z.object({
  id: z.string(),
  type: z.literal("meal"),
  eatenAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  description: z.string(),
  restaurantLink: z.string().url().optional(),
  photos: z.array(mealPhotoSchema).default([]),
  photoFileId: z.string().optional(),
  photoFileName: z.string().optional(),
  nutrition: nutritionEstimateSchema,
  correctedNutrition: macroSchema.optional(),
  correctionNote: z.string().optional(),
});

export const symptomRecordSchema = z.object({
  id: z.string(),
  type: z.literal("symptom"),
  occurredAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  severity: z.number().int().min(1).max(5),
  durationMinutes: z.number().int().positive().optional(),
  tags: z.array(z.string()),
  note: z.string(),
});

export const mealInputSchema = z.object({
  description: z.string().trim().optional(),
  restaurantLink: optionalUrlSchema,
  eatenAt: z.string().datetime().optional(),
});

export const symptomInputSchema = z.object({
  occurredAt: z.string().datetime().optional(),
  severity: z.coerce.number().int().min(1).max(5).default(3),
  durationMinutes: z.coerce.number().int().positive().optional(),
  tags: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((tag) => tag.trim().toLowerCase())
            .filter(Boolean)
        : [],
    ),
  note: z.string().trim().min(1, "Add a symptom note."),
});

export const timelineItemSchema = z.discriminatedUnion("type", [
  mealRecordSchema,
  symptomRecordSchema,
]);

export const reportSummarySchema = z.object({
  generatedAt: z.string().datetime(),
  meals: z.array(mealRecordSchema),
  symptoms: z.array(symptomRecordSchema),
  totals: macroSchema,
  dailyAverages: macroSchema,
  mealsLogged: z.number().int().nonnegative(),
  symptomsLogged: z.number().int().nonnegative(),
  weeklySummaries: z.array(
    z.object({
      weekStart: z.string(),
      totals: macroSchema,
      dailyAverages: macroSchema,
      mealsLogged: z.number().int().nonnegative(),
      symptomsLogged: z.number().int().nonnegative(),
    }),
  ),
  possibleAssociations: z.array(
    z.object({
      trigger: z.string(),
      symptomCountWithinSixHours: z.number().int().nonnegative(),
      mealCount: z.number().int().nonnegative(),
      note: z.string(),
    }),
  ),
});

export type MacroTotals = z.infer<typeof macroSchema>;
export type NutritionEstimate = z.infer<typeof nutritionEstimateSchema>;
export type TrackedNutrient = z.infer<typeof trackedNutrientSchema>;
export type MealRecord = z.infer<typeof mealRecordSchema>;
export type SymptomRecord = z.infer<typeof symptomRecordSchema>;
export type TimelineItem = z.infer<typeof timelineItemSchema>;
export type ReportSummary = z.infer<typeof reportSummarySchema>;
