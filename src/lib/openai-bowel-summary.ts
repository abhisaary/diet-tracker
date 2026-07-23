import OpenAI from "openai";
import { z } from "zod";

import { getEnv, getOptionalEnv } from "@/lib/env";

const bowelImageSummarySchema = z.object({
  summary: z.string().trim().min(1).max(200),
});

const bowelImageSummaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description: "A short, neutral, non-diagnostic visual description.",
    },
  },
  required: ["summary"],
};

export async function summarizeBowelMovementImage({
  bytes,
  mimeType,
}: {
  bytes: Buffer;
  mimeType: string;
}) {
  const model = getOptionalEnv("OPENAI_MODEL") ?? "gpt-5.5";
  const client = new OpenAI({ apiKey: getEnv("OPENAI_API_KEY") });
  const imageDataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
  const response = await client.responses.create({
    input: [
      {
        content: [
          {
            text: [
              "Write one short, neutral sentence describing only the visible appearance of this bowel movement for a private personal log.",
              "Use plain, non-alarming language. You may describe obvious color, overall form, and visible consistency.",
              "Do not assign a Bristol Stool Scale type, identify blood, mucus, parasites, or disease, make health inferences, diagnose anything, or provide medical advice.",
              "Do not speculate beyond what is clearly visible.",
              "If no bowel movement is clearly visible, say exactly: No bowel movement is clearly visible in the image.",
            ].join(" "),
            type: "input_text",
          },
          {
            detail: "low",
            image_url: imageDataUrl,
            type: "input_image",
          },
        ],
        role: "user",
      },
    ],
    max_output_tokens: 120,
    model,
    text: {
      format: {
        name: "bowel_movement_image_summary",
        schema: bowelImageSummaryJsonSchema,
        strict: true,
        type: "json_schema",
      },
    },
  });
  const parsed = bowelImageSummarySchema.parse(
    JSON.parse(response.output_text),
  );

  return {
    model,
    summary: parsed.summary,
  };
}
