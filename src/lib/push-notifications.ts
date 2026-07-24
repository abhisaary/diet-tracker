import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import webpush from "web-push";

import { getOptionalEnv } from "@/lib/env";
import {
  claimReminderDelivery,
  deletePushSubscription,
  finishReminderDelivery,
  listEnabledNotificationSettings,
  listPushSubscriptions,
  type PushSubscriptionRecord,
} from "@/lib/notification-storage";
import type { NotificationSettings } from "@/lib/schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

const deliveryWindowMilliseconds = 2 * 60 * 1000;
let webPushConfigured = false;

function configureWebPush() {
  if (webPushConfigured) {
    return;
  }

  const publicKey = getOptionalEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY");
  const privateKey = getOptionalEnv("VAPID_PRIVATE_KEY");
  const subject = getOptionalEnv("VAPID_SUBJECT");

  if (!publicKey || !privateKey || !subject) {
    throw new Error(
      "Push delivery requires NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT.",
    );
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  webPushConfigured = true;
}

function getDueReminderSlots(
  settings: NotificationSettings,
  now: Date,
) {
  const earliestCandidate = new Date(
    now.getTime() - deliveryWindowMilliseconds,
  );
  const localDates = new Set([
    formatInTimeZone(now, settings.timezone, "yyyy-MM-dd"),
    formatInTimeZone(earliestCandidate, settings.timezone, "yyyy-MM-dd"),
  ]);

  return [...localDates].flatMap((localDate) =>
    settings.reminderTimes.flatMap((reminderTime) => {
      const scheduledFor = fromZonedTime(
        `${localDate}T${reminderTime}:00`,
        settings.timezone,
      );
      const ageMilliseconds = now.getTime() - scheduledFor.getTime();
      const weekday = Number(
        formatInTimeZone(scheduledFor, settings.timezone, "i"),
      );
      const isAllowedDay =
        settings.dayPattern === "daily" || (weekday >= 1 && weekday <= 5);

      return isAllowedDay &&
        ageMilliseconds >= 0 &&
        ageMilliseconds < deliveryWindowMilliseconds
        ? [{ reminderTime, scheduledFor }]
        : [];
    }),
  );
}

function getPushStatusCode(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }

  return undefined;
}

async function sendToSubscription(
  supabase: SupabaseClient,
  subscription: PushSubscriptionRecord,
) {
  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: {
          auth: subscription.auth,
          p256dh: subscription.p256dh,
        },
      },
      JSON.stringify({
        badge: 1,
        body: "Don’t forget to log your meal 😋",
        icon: "/icon.png",
        tag: "meal-reminder",
        title: "It’s food’o’clock!",
        url: "/?form=meal",
      }),
      {
        TTL: 60 * 60,
        urgency: "normal",
      },
    );

    return true;
  } catch (error) {
    const statusCode = getPushStatusCode(error);

    if (statusCode === 404 || statusCode === 410) {
      await deletePushSubscription(supabase, subscription.id).catch(
        () => undefined,
      );
    }

    console.error("[meal-reminder-push]", {
      error,
      statusCode,
      subscriptionId: subscription.id,
    });
    return false;
  }
}

export async function dispatchDueMealReminders({
  now = new Date(),
  supabase,
}: {
  now?: Date;
  supabase: SupabaseClient;
}) {
  configureWebPush();

  const configuredUsers = await listEnabledNotificationSettings(supabase);
  let claimed = 0;
  let duplicates = 0;
  let failed = 0;
  let sent = 0;

  for (const configuredUser of configuredUsers) {
    let dueSlots: ReturnType<typeof getDueReminderSlots>;

    try {
      dueSlots = getDueReminderSlots(configuredUser.settings, now);
    } catch (error) {
      console.error("[meal-reminder-timezone]", {
        error,
        timezone: configuredUser.settings.timezone,
        userId: configuredUser.userId,
      });
      continue;
    }

    for (const dueSlot of dueSlots) {
      const deliveryId = await claimReminderDelivery({
        reminderTime: dueSlot.reminderTime,
        scheduledFor: dueSlot.scheduledFor.toISOString(),
        supabase,
        userId: configuredUser.userId,
      });

      if (!deliveryId) {
        duplicates += 1;
        continue;
      }

      claimed += 1;
      const subscriptions = await listPushSubscriptions(
        supabase,
        configuredUser.userId,
      );

      if (!subscriptions.length) {
        failed += 1;
        await finishReminderDelivery({
          deliveryId,
          errorMessage: "No active push subscriptions.",
          sentSubscriptions: 0,
          status: "failed",
          supabase,
        });
        continue;
      }

      const results = await Promise.all(
        subscriptions.map((subscription) =>
          sendToSubscription(supabase, subscription),
        ),
      );
      const sentSubscriptions = results.filter(Boolean).length;
      const status = sentSubscriptions > 0 ? "sent" : "failed";

      if (status === "sent") {
        sent += 1;
      } else {
        failed += 1;
      }

      await finishReminderDelivery({
        deliveryId,
        errorMessage:
          status === "failed"
            ? "Push delivery failed for every active subscription."
            : undefined,
        sentSubscriptions,
        status,
        supabase,
      });
    }
  }

  return {
    claimed,
    duplicates,
    failed,
    sent,
    usersChecked: configuredUsers.length,
  };
}
