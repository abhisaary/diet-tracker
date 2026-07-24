import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { getOptionalEnv } from "@/lib/env";
import { createAdminSupabaseClient } from "@/lib/notification-storage";
import { dispatchDueMealReminders } from "@/lib/push-notifications";

export const runtime = "nodejs";
export const maxDuration = 60;

function matchesSecret(provided: string, expected: string) {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);

  return (
    providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes)
  );
}

export async function POST(request: Request) {
  const cronSecret = getOptionalEnv("NOTIFICATION_CRON_SECRET");
  const authorization = request.headers.get("authorization");
  const providedSecret = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";

  if (!cronSecret) {
    console.error("[meal-reminder-dispatch] NOTIFICATION_CRON_SECRET is missing.");
    return NextResponse.json(
      { error: "Reminder dispatch is not configured." },
      { status: 503 },
    );
  }

  if (!matchesSecret(providedSecret, cronSecret)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const result = await dispatchDueMealReminders({
      supabase: createAdminSupabaseClient(),
    });

    console.info("[meal-reminder-dispatch]", result);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[meal-reminder-dispatch]", error);
    return NextResponse.json(
      { error: "Reminder dispatch failed." },
      { status: 500 },
    );
  }
}
