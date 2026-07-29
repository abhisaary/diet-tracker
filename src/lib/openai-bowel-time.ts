import OpenAI from "openai";
import { z } from "zod";

import { getEnv, getOptionalEnv } from "@/lib/env";

const bowelOccurredAtSchema = z.object({
  inferredOccurredAt: z.string().datetime().nullable(),
});

const bowelOccurredAtJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    inferredOccurredAt: {
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
      description:
        "UTC ISO 8601 timestamp ending in Z when the note clearly states or implies when the bowel movement happened. Otherwise null.",
    },
  },
  required: ["inferredOccurredAt"],
};

export async function inferBowelMovementOccurredAt({
  note,
  submittedAt,
  timezone,
}: {
  note: string;
  submittedAt: string;
  timezone?: string;
}) {
  const trimmedNote = note.trim();

  if (!trimmedNote) {
    return null;
  }

  const model = getOptionalEnv("OPENAI_MODEL") ?? "gpt-5.5";
  const client = new OpenAI({ apiKey: getEnv("OPENAI_API_KEY") });
  const response = await client.responses.create({
    input: [
      {
        content: [
          {
            text: [
              "Infer when a personal bowel-movement log happened from the user's optional note.",
              "If the note clearly states or implies a time, return inferredOccurredAt as a UTC ISO 8601 timestamp ending in Z.",
              "Resolve relative phrases such as 30 minutes ago, an hour ago, this morning, last night, or yesterday using the submission time and timezone.",
              "If the note does not clearly indicate when it happened, return null.",
              "Do not invent a time from unrelated text.",
              `The submission time is ${submittedAt}.`,
              timezone
                ? `The user's local timezone is ${timezone}.`
                : "",
              "",
              `Note: ${trimmedNote}`,
            ]
              .filter(Boolean)
              .join(" "),
            type: "input_text",
          },
        ],
        role: "user",
      },
    ],
    max_output_tokens: 80,
    model,
    text: {
      format: {
        name: "bowel_movement_occurred_at",
        schema: bowelOccurredAtJsonSchema,
        strict: true,
        type: "json_schema",
      },
    },
  });
  const parsed = bowelOccurredAtSchema.parse(JSON.parse(response.output_text));

  return parsed.inferredOccurredAt;
}
