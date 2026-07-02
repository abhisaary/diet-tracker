import OpenAI from "openai";
import { z } from "zod";

import { getEnv, getOptionalEnv } from "@/lib/env";
import type { NutritionEstimate } from "@/lib/schemas";

const estimateResponseSchema = z.object({
  calories: z.number().nonnegative(),
  cleanedDescription: z.string(),
  proteinGrams: z.number().nonnegative(),
  carbsGrams: z.number().nonnegative(),
  fatGrams: z.number().nonnegative(),
  fiberGrams: z.number().nonnegative(),
  confidence: z.enum(["low", "medium", "high"]),
  estimatedPortion: z.string(),
  ingredientEstimates: z.array(
    z.object({
      amount: z.string(),
      name: z.string(),
    }),
  ),
  inferredMealTime: z.string().datetime().nullable(),
  mealTitle: z.string(),
  notableIngredients: z.array(z.string()),
  possibleTriggers: z.array(z.string()),
  assumptions: z.array(z.string()),
});

const estimateJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    calories: { type: "number", minimum: 0 },
    cleanedDescription: { type: "string" },
    proteinGrams: { type: "number", minimum: 0 },
    carbsGrams: { type: "number", minimum: 0 },
    fatGrams: { type: "number", minimum: 0 },
    fiberGrams: { type: "number", minimum: 0 },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
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
  },
  required: [
    "calories",
    "cleanedDescription",
    "proteinGrams",
    "carbsGrams",
    "fatGrams",
    "fiberGrams",
    "confidence",
    "estimatedPortion",
    "ingredientEstimates",
    "inferredMealTime",
    "mealTitle",
    "notableIngredients",
    "possibleTriggers",
    "assumptions",
  ],
};

export async function estimateMealNutrition({
  description,
  imageBytes,
  mimeType,
  restaurantLink,
  submittedAt,
  timezone,
}: {
  description: string;
  imageBytes?: Buffer;
  mimeType?: string;
  restaurantLink?: string;
  submittedAt?: string;
  timezone?: string;
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
    "Return mealTitle as a short display title, like 'Tofu Sisig Burrito' or 'Greek Yogurt Bowl'.",
    "Return cleanedDescription as a concise normalized meal description suitable for a meal log.",
    "Return ingredientEstimates as a complete ingredient list with approximate amounts per ingredient.",
    "If the description clearly states or implies when the meal was eaten, return inferredMealTime as a UTC ISO 8601 timestamp ending in Z. Otherwise return null.",
    `The submission time is ${submittedAtIso}.`,
    timezone ? `The user's local timezone is ${timezone}. Use it to resolve relative phrases like this morning, last night, yesterday, or 30 minutes ago.` : "",
    "Prefer plausible ballpark estimates and explain uncertainty in assumptions.",
    "Identify broad possible trigger categories such as dairy, gluten, alcohol, spicy food, high fiber, fried food, legumes, artificial sweeteners, caffeine, or high fat when visible or implied.",
    "",
    `Description: ${description || "No written description provided."}`,
    restaurantLink ? `Restaurant/menu link: ${restaurantLink}` : "",
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
