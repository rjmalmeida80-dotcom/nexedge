// NexEdge — Service Worker para Push Notifications
self.addEventListener('push', function(event) {
  if (!event.data) return;

  let data = {};
  try { data = event.data.json(); } catch(e) { data = { title: 'NexEdge', body: event.data.text() }; }

  const options = {
    body: data.body || '',
    icon: '/nexhr-icon.png',
    badge: '/nexhr-icon.png',
    tag: data.tag || 'nexedge',
    data: { url: data.url || '/' },
    actions: [
      { action: 'ver', title: 'Ver' },
      { action: 'fechar', title: 'Fechar' },
    ],
    requireInteraction: false,
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'NexEdge', options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  if (event.action === 'fechar') return;

  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
