import { after, NextResponse } from "next/server";
import { z } from "zod";

import { summarizeBowelMovementImage } from "@/lib/openai-bowel-summary";
import { bowelMovementInputSchema } from "@/lib/schemas";
import {
  completeBowelMovementSummary,
  deleteBowelMovement,
  downloadBowelMovementPhoto,
  failBowelMovementSummary,
  getAuthenticatedSupabase,
  getBowelMovement,
  insertBowelMovement,
  listBowelMovements,
} from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 60;

const deleteInputSchema = z.object({
  id: z.string().uuid(),
});

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function isUserOwnedPhotoPath(path: string, userId: string) {
  const pathSegments = path.split("/");

  return (
    pathSegments.length >= 3 &&
    pathSegments[0] === userId &&
    pathSegments.every((segment) => segment.length > 0 && segment !== "..")
  );
}

export async function GET(request: Request) {
  const auth = await getAuthenticatedSupabase(request);

  if (!auth) {
    return jsonError("Sign in before loading bowel movements.", 401);
  }

  const bowelMovements = await listBowelMovements(
    auth.supabase,
    auth.user.id,
  );

  return NextResponse.json({ bowelMovements });
}

export async function POST(request: Request) {
  const auth = await getAuthenticatedSupabase(request);

  if (!auth) {
    return jsonError("Sign in before logging a bowel movement.", 401);
  }

  const input = bowelMovementInputSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!input.success) {
    return jsonError(
      input.error.issues[0]?.message ?? "Invalid bowel movement input.",
    );
  }

  if (
    input.data.photo &&
    !isUserOwnedPhotoPath(input.data.photo.fileId, auth.user.id)
  ) {
    return jsonError("The selected photo is not in your private storage.");
  }

  const existing = await getBowelMovement(
    auth.supabase,
    auth.user.id,
    input.data.id,
  );

  if (existing) {
    return NextResponse.json({ bowelMovement: existing });
  }

  const occurredAt = input.data.occurredAt ?? new Date().toISOString();
  let bowelMovement;

  try {
    bowelMovement = await insertBowelMovement({
      id: input.data.id,
      note: input.data.note,
      occurredAt,
      photo: input.data.photo,
      supabase: auth.supabase,
      userId: auth.user.id,
    });
  } catch (error) {
    const concurrentlyCreated = await getBowelMovement(
      auth.supabase,
      auth.user.id,
      input.data.id,
    );

    if (concurrentlyCreated) {
      return NextResponse.json({ bowelMovement: concurrentlyCreated });
    }

    throw error;
  }

  if (bowelMovement.photo) {
    const photo = bowelMovement.photo;
    const bowelMovementId = bowelMovement.id;

    after(async () => {
      try {
        const image = await downloadBowelMovementPhoto(auth.supabase, photo);
        const result = await summarizeBowelMovementImage(image);

        await completeBowelMovementSummary({
          id: bowelMovementId,
          model: result.model,
          summary: result.summary,
          supabase: auth.supabase,
          userId: auth.user.id,
        });
      } catch (error) {
        console.error("[bowel-image-summary]", {
          error,
          id: bowelMovementId,
        });

        await failBowelMovementSummary({
          errorMessage: "Image summary could not be generated.",
          id: bowelMovementId,
          supabase: auth.supabase,
          userId: auth.user.id,
        }).catch(() => undefined);
      }
    });
  }

  return NextResponse.json({ bowelMovement }, { status: 201 });
}

export async function DELETE(request: Request) {
  const auth = await getAuthenticatedSupabase(request);

  if (!auth) {
    return jsonError("Sign in before deleting a bowel movement.", 401);
  }

  const input = deleteInputSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!input.success) {
    return jsonError("Choose a valid bowel movement to delete.");
  }

  await deleteBowelMovement({
    id: input.data.id,
    supabase: auth.supabase,
    userId: auth.user.id,
  });

  return NextResponse.json({ success: true });
}
