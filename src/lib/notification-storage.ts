import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getEnv, getOptionalEnv } from "@/lib/env";
import { notificationSettingsSchema } from "@/lib/schemas";
import type {
  NotificationDayPattern,
  NotificationSettings,
  StoredPushSubscription,
} from "@/lib/schemas";

type NotificationSettingsRow = {
  user_id: string;
  enabled: boolean;
  timezone: string;
  day_pattern: string;
  reminder_times: string[];
  created_at: string;
  updated_at: string;
};

export type PushSubscriptionRecord = {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export const defaultReminderTimes = ["08:00", "12:30", "19:00"];

function toNotificationSettings(
  row: NotificationSettingsRow,
): NotificationSettings {
  return notificationSettingsSchema.parse({
    dayPattern: row.day_pattern,
    enabled: row.enabled,
    reminderTimes: row.reminder_times,
    timezone: row.timezone,
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

export function getDefaultNotificationSettings(
  timezone = "UTC",
): NotificationSettings {
  return {
    dayPattern: "daily",
    enabled: false,
    reminderTimes: defaultReminderTimes,
    timezone,
  };
}

export function createAdminSupabaseClient() {
  const serviceRoleKey = getOptionalEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!serviceRoleKey) {
    throw new Error("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(getEnv("NEXT_PUBLIC_SUPABASE_URL"), serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export async function getNotificationSettings(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ configured: boolean; settings: NotificationSettings }> {
  const { data, error } = await supabase
    .from("notification_settings")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data
    ? {
        configured: true,
        settings: toNotificationSettings(data as NotificationSettingsRow),
      }
    : {
        configured: false,
        settings: getDefaultNotificationSettings(),
      };
}

export async function saveNotificationSettings({
  dayPattern,
  enabled,
  reminderTimes,
  supabase,
  timezone,
  userId,
}: {
  dayPattern: NotificationDayPattern;
  enabled: boolean;
  reminderTimes: string[];
  supabase: SupabaseClient;
  timezone: string;
  userId: string;
}) {
  const { data, error } = await supabase
    .from("notification_settings")
    .upsert(
      {
        day_pattern: dayPattern,
        enabled,
        reminder_times: reminderTimes,
        timezone,
        updated_at: new Date().toISOString(),
        user_id: userId,
      },
      { onConflict: "user_id" },
    )
    .select("*")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return toNotificationSettings(data as NotificationSettingsRow);
}

export async function savePushSubscription({
  subscription,
  supabase,
  userAgent,
}: {
  subscription: StoredPushSubscription;
  supabase: SupabaseClient;
  userAgent?: string;
}) {
  const { error } = await supabase.rpc("upsert_push_subscription", {
    p_auth: subscription.keys.auth,
    p_endpoint: subscription.endpoint,
    p_p256dh: subscription.keys.p256dh,
    p_user_agent: userAgent ?? null,
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function hasPushSubscription(
  supabase: SupabaseClient,
  userId: string,
) {
  const { count, error } = await supabase
    .from("push_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  if (error) {
    throw new Error(error.message);
  }

  return (count ?? 0) > 0;
}

export async function listEnabledNotificationSettings(
  supabase: SupabaseClient,
) {
  const { data, error } = await supabase
    .from("notification_settings")
    .select("*")
    .eq("enabled", true);

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as NotificationSettingsRow[]).map((row) => ({
    settings: toNotificationSettings(row),
    userId: row.user_id,
  }));
}

export async function listPushSubscriptions(
  supabase: SupabaseClient,
  userId: string,
): Promise<PushSubscriptionRecord[]> {
  const { data, error } = await supabase
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth")
    .eq("user_id", userId);

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => ({
    auth: row.auth,
    endpoint: row.endpoint,
    id: row.id,
    p256dh: row.p256dh,
    userId: row.user_id,
  }));
}

export async function claimReminderDelivery({
  reminderTime,
  scheduledFor,
  supabase,
  userId,
}: {
  reminderTime: string;
  scheduledFor: string;
  supabase: SupabaseClient;
  userId: string;
}) {
  const { data, error } = await supabase
    .from("reminder_deliveries")
    .insert({
      reminder_time: reminderTime,
      scheduled_for: scheduledFor,
      status: "processing",
      user_id: userId,
    })
    .select("id")
    .single();

  if (!error) {
    return data.id as string;
  }

  if (error.code !== "23505") {
    throw new Error(error.message);
  }

  const { data: existing, error: existingError } = await supabase
    .from("reminder_deliveries")
    .select("id, status, updated_at")
    .eq("user_id", userId)
    .eq("scheduled_for", scheduledFor)
    .maybeSingle();

  if (existingError) {
    throw new Error(existingError.message);
  }

  if (!existing || existing.status === "sent") {
    return undefined;
  }

  const staleProcessing =
    existing.status === "processing" &&
    Date.now() - new Date(existing.updated_at).getTime() >= 60_000;

  if (existing.status !== "failed" && !staleProcessing) {
    return undefined;
  }

  const { data: reclaimed, error: reclaimError } = await supabase
    .from("reminder_deliveries")
    .update({
      error_message: null,
      status: "processing",
      updated_at: new Date().toISOString(),
    })
    .eq("id", existing.id)
    .eq("updated_at", existing.updated_at)
    .select("id")
    .maybeSingle();

  if (reclaimError) {
    throw new Error(reclaimError.message);
  }

  return reclaimed?.id as string | undefined;
}

export async function finishReminderDelivery({
  deliveryId,
  errorMessage,
  sentSubscriptions,
  status,
  supabase,
}: {
  deliveryId: string;
  errorMessage?: string;
  sentSubscriptions: number;
  status: "failed" | "sent";
  supabase: SupabaseClient;
}) {
  const { error } = await supabase
    .from("reminder_deliveries")
    .update({
      error_message: errorMessage ?? null,
      sent_subscriptions: sentSubscriptions,
      status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", deliveryId);

  if (error) {
    throw new Error(error.message);
  }
}

export async function deletePushSubscription(
  supabase: SupabaseClient,
  subscriptionId: string,
) {
  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("id", subscriptionId);

  if (error) {
    throw new Error(error.message);
  }
}
