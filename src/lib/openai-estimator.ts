import OpenAI from "openai";
import { z } from "zod";

import { getEnv, getOptionalEnv } from "@/lib/env";
import type { NutritionEstimate, TrackedNutrient } from "@/lib/schemas";

const estimateResponseSchema = z.object({
  calories: z.number().nonnegative(),
  calculationSummary: z.string(),
  cleanedDescription: z.string(),
  proteinGrams: z.number().nonnegative(),
  carbsGrams: z.number().nonnegative(),
  fatGrams: z.number().nonnegative(),
  fiberGrams: z.number().nonnegative(),
  confidence: z.enum(["low", "medium", "high"]),
  customNutrients: z.array(
    z.object({
      amount: z.number().nonnegative(),
      confidence: z.enum(["low", "medium", "high"]),
      name: z.string(),
      unit: z.string(),
    }),
  ),
  estimatedPortion: z.string(),
  ingredientEstimates: z.array(
    z.object({
      amount: z.string(),
      name: z.string(),
    }),
  ),
  inferredMealTime: z.string().datetime().nullable(),
  macroBreakdown: z.array(
    z.object({
      amount: z.string(),
      name: z.string(),
      calories: z.number().nonnegative(),
      proteinGrams: z.number().nonnegative(),
      carbsGrams: z.number().nonnegative(),
      fatGrams: z.number().nonnegative(),
      fiberGrams: z.number().nonnegative(),
      macroBasis: z.string(),
    }),
  ),
  mealTitle: z.string(),
  notableIngredients: z.array(z.string()),
  possibleTriggers: z.array(z.string()),
  sanityCheck: z.string(),
  assumptions: z.array(z.string()),
});

const estimateJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    calories: { type: "number", minimum: 0 },
    calculationSummary: { type: "string" },
    cleanedDescription: { type: "string" },
    proteinGrams: { type: "number", minimum: 0 },
    carbsGrams: { type: "number", minimum: 0 },
    fatGrams: { type: "number", minimum: 0 },
    fiberGrams: { type: "number", minimum: 0 },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    customNutrients: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          amount: { type: "number", minimum: 0 },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          name: { type: "string" },
          unit: { type: "string" },
        },
        required: ["name", "unit", "amount", "confidence"],
      },
    },
    estimatedPortion: { type: "string" },
    ingredientEstimates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          amount: { type: "string" },
          name: { type: "string" },
        },
        required: ["name", "amount"],
      },
    },
    inferredMealTime: {
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    },
    macroBreakdown: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          amount: { type: "string" },
          name: { type: "string" },
          calories: { type: "number", minimum: 0 },
          proteinGrams: { type: "number", minimum: 0 },
          carbsGrams: { type: "number", minimum: 0 },
          fatGrams: { type: "number", minimum: 0 },
          fiberGrams: { type: "number", minimum: 0 },
          macroBasis: { type: "string" },
        },
        required: [
          "name",
          "amount",
          "calories",
          "proteinGrams",
          "carbsGrams",
          "fatGrams",
          "fiberGrams",
          "macroBasis",
        ],
      },
    },
    mealTitle: { type: "string" },
    notableIngredients: {
      type: "array",
      items: { type: "string" },
    },
    possibleTriggers: {
      type: "array",
      items: { type: "string" },
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
    },
    sanityCheck: { type: "string" },
  },
  required: [
    "calories",
    "calculationSummary",
    "cleanedDescription",
    "proteinGrams",
    "carbsGrams",
    "fatGrams",
    "fiberGrams",
    "confidence",
    "customNutrients",
    "estimatedPortion",
    "ingredientEstimates",
    "inferredMealTime",
    "macroBreakdown",
    "mealTitle",
    "notableIngredients",
    "possibleTriggers",
    "assumptions",
    "sanityCheck",
  ],
};

export async function estimateMealNutrition({
  description,
  imageBytes,
  mimeType,
  recentMealContext,
  restaurantLink,
  submittedAt,
  timezone,
  trackedNutrients,
}: {
  description: string;
  imageBytes?: Buffer;
  mimeType?: string;
  recentMealContext?: string;
  restaurantLink?: string;
  submittedAt?: string;
  timezone?: string;
  trackedNutrients?: TrackedNutrient[];
}): Promise<NutritionEstimate> {
  const model = getOptionalEnv("OPENAI_MODEL") ?? "gpt-5.5";
  const client = new OpenAI({ apiKey: getEnv("OPENAI_API_KEY") });
  const submittedAtIso = submittedAt ?? new Date().toISOString();
  const prompt = [
    "Estimate nutrition for a personal diet and gut-symptom tracker.",
    imageBytes
      ? "Use the image and user description as evidence."
      : "Use the user description as evidence. No meal image was provided.",
    "The goal is rough trend tracking, not gram-perfect diet logging.",
    "Use this workflow before returning JSON: first estimate a complete ingredient list and portion size for each ingredient from the image, description, and any menu context; then calculate each ingredient's macro contribution from typical nutrition data; then sum those contributions into the top-level calories/protein/carbs/fat/fiber; finally sanity-check whether the total seems plausible for the visible meal size and restaurant/home context.",
    "Return mealTitle as a short display title, like 'Tofu Sisig Burrito' or 'Greek Yogurt Bowl'.",
    "Return cleanedDescription as a concise normalized meal description suitable for a meal log.",
    "Return ingredientEstimates as a complete ingredient list with approximate amounts per ingredient.",
    "Return macroBreakdown using the same ingredients as ingredientEstimates. Each macroBasis should be a brief citation-like phrase such as 'typical cooked white rice, 1 cup' or 'plain Greek yogurt, 170 g'.",
    trackedNutrients?.length
      ? `Also estimate these user-selected nutrients and return them in customNutrients using exactly these names and units: ${trackedNutrients.map((nutrient) => `${nutrient.name} (${nutrient.unit})`).join(", ")}.`
      : "Return customNutrients as an empty array because the user has not selected additional nutrients.",
    "Return calculationSummary as a concise one-sentence explanation of the ingredient-sum calculation. Return sanityCheck as one concise sentence noting whether the total looks plausible or what could swing it.",
    "Do not include hidden step-by-step reasoning; store only concise estimates, assumptions, calculationSummary, sanityCheck, and per-ingredient macroBasis.",
    recentMealContext
      ? "Recent meal context is provided below. Use it only when the user's description clearly refers to a prior meal, such as 'same salad as yesterday', 'the usual breakfast', or 'same as last night'. If the current photo or description conflicts with prior context, prefer the current photo/description. If you reuse prior context, mention the referenced meal in assumptions."
      : "",
    "If the description clearly states or implies when the meal was eaten, return inferredMealTime as a UTC ISO 8601 timestamp ending in Z. Otherwise return null.",
    `The submission time is ${submittedAtIso}.`,
    timezone ? `The user's local timezone is ${timezone}. Use it to resolve relative phrases like this morning, last night, yesterday, or 30 minutes ago.` : "",
    "Prefer plausible ballpark estimates and explain uncertainty in assumptions.",
    "Identify broad possible trigger categories such as dairy, gluten, alcohol, spicy food, high fiber, fried food, legumes, artificial sweeteners, caffeine, or high fat when visible or implied.",
    "",
    `Description: ${description || "No written description provided."}`,
    restaurantLink ? `Restaurant/menu link: ${restaurantLink}` : "",
    recentMealContext ? `Recent meals:\n${recentMealContext}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const content: (
    | { text: string; type: "input_text" }
    | { detail: "high"; image_url: string; type: "input_image" }
  )[] = [{ text: prompt, type: "input_text" }];

  if (imageBytes && mimeType) {
    const imageDataUrl = `data:${mimeType};base64,${imageBytes.toString("base64")}`;
    content.push({
      detail: "high",
      image_url: imageDataUrl,
      type: "input_image",
    });
  }

  const response = await client.responses.create({
    input: [
      {
        content,
        role: "user",
      },
    ],
    model,
    text: {
      format: {
        name: "meal_nutrition_estimate",
        schema: estimateJsonSchema,
        strict: true,
        type: "json_schema",
      },
    },
    tool_choice: "auto",
    tools: [{ type: "web_search" }],
  });

  const parsed = estimateResponseSchema.parse(JSON.parse(response.output_text));

  return {
    ...parsed,
    estimatedAt: new Date().toISOString(),
    model,
  };
}
