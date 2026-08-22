/**
 * NexEdge — Service Worker PWA
 * Cache offline + Push Notifications
 */

const CACHE_NAME = 'nexedge-v2';
const CACHE_URLS = ['/', '/index.html', '/logistica', '/wms', '/torre-controlo'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(CACHE_URLS).catch(()=>{})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
  )));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('/api/')) return; // nunca cache APIs
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// Push Notification handler
self.addEventListener('push', e => {
  if (!e.data) return;
  const data = e.data.json();
  e.waitUntil(self.registration.showNotification(data.titulo || 'NexEdge', {
    body: data.mensagem || '',
    icon: '/favicon.png',
    badge: '/favicon.png',
    tag: data.tag || 'nexedge',
    data: { url: data.url || '/' },
    actions: data.accoes || [],
    vibrate: [200, 100, 200],
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(clients.matchAll({type:'window'}).then(cs => {
    const c = cs.find(c => c.url === url);
    return c ? c.focus() : clients.openWindow(url);
  }));
});
