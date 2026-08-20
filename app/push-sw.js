// House of Martin — Web Push service worker. Registered from app/index.html
// (subscribeToPush()) as a plain background push handler, no Firebase SDK
// involved here — the server side (functions/index.js) sends raw Web Push
// via the `web-push` library, not Firebase Cloud Messaging.

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (err) { data = { title: 'House of Martin', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'House of Martin';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
