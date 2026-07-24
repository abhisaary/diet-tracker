self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};

  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = {};
  }

  const showNotification = self.registration.showNotification(
    payload.title || "It's food'o'clock 😋",
    {
      body: payload.body || "Don't forget to log your meal 🍱",
      data: {
        url: payload.url || "/?form=meal",
      },
      icon: payload.icon || "/icon.png",
      tag: payload.tag || "meal-reminder",
    },
  );
  const setBadge =
    "setAppBadge" in self.navigator
      ? self.navigator.setAppBadge(payload.badge || 1).catch(() => undefined)
      : Promise.resolve();

  event.waitUntil(Promise.all([showNotification, setBadge]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = new URL(
    event.notification.data?.url || "/?form=meal",
    self.location.origin,
  ).href;

  event.waitUntil(
    self.clients
      .matchAll({ includeUncontrolled: true, type: "window" })
      .then(async (windowClients) => {
        const existingClient = windowClients.find(
          (client) => new URL(client.url).origin === self.location.origin,
        );

        if (existingClient) {
          await existingClient.navigate(targetUrl);
          return existingClient.focus();
        }

        return self.clients.openWindow(targetUrl);
      }),
  );
});
