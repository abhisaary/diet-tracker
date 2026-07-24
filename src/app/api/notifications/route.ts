import { NextResponse } from "next/server";

import {
  getNotificationSettings,
  hasPushSubscription,
  saveNotificationSettings,
  savePushSubscription,
} from "@/lib/notification-storage";
import { notificationSettingsInputSchema } from "@/lib/schemas";
import { getAuthenticatedSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function isValidTimeZone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  const auth = await getAuthenticatedSupabase(request);

  if (!auth) {
    return jsonError("Sign in before loading notification settings.", 401);
  }

  const result = await getNotificationSettings(
    auth.supabase,
    auth.user.id,
  );
  const requestedTimezone = new URL(request.url).searchParams.get("timezone");
  const settings =
    !result.configured &&
    requestedTimezone &&
    isValidTimeZone(requestedTimezone)
      ? { ...result.settings, timezone: requestedTimezone }
      : result.settings;

  return NextResponse.json(
    { configured: result.configured, settings },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(request: Request) {
  const auth = await getAuthenticatedSupabase(request);

  if (!auth) {
    return jsonError("Sign in before saving notification settings.", 401);
  }

  const input = notificationSettingsInputSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!input.success) {
    return jsonError(
      input.error.issues[0]?.message ?? "Invalid notification settings.",
    );
  }

  if (!isValidTimeZone(input.data.timezone)) {
    return jsonError("Choose a valid timezone.");
  }

  if (input.data.subscription) {
    await savePushSubscription({
      subscription: input.data.subscription,
      supabase: auth.supabase,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
  }

  if (
    input.data.enabled &&
    !(await hasPushSubscription(auth.supabase, auth.user.id))
  ) {
    return jsonError(
      "Enable notifications on this device before activating reminders.",
    );
  }

  const settings = await saveNotificationSettings({
    dayPattern: input.data.dayPattern,
    enabled: input.data.enabled,
    reminderTimes: input.data.reminderTimes,
    supabase: auth.supabase,
    timezone: input.data.timezone,
    userId: auth.user.id,
  });

  return NextResponse.json({ settings });
}
