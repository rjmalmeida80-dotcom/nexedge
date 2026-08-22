/**
 * NexEdge — Push Notifications PWA
 * Service Worker + VAPID para notificações nativas no browser/mobile
 */

const VAPID_PUBLIC = 'BAzIgAtuPyYzAR8xFiKkgTyezuxB_MebaIbtWAt099pmru3cqcBLjZ2aDt5NIRi3WRgX4LcERPzVF_vmPbY_E8g';

async function registarPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.log('[Push] Não suportado neste browser');
    return false;
  }

  try {
    const reg = await navigator.serviceWorker.register('/sw-nexedge.js');
    console.log('[Push] Service Worker registado');

    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { console.log('[Push] Permissão negada'); return false; }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC)
    });

    // Enviar subscrição ao backend
    const token = getToken();
    if (token) {
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+token },
        body: JSON.stringify({ subscription: sub.toJSON() })
      });
      console.log('[Push] Subscrito com sucesso');
    }
    return true;
  } catch(e) {
    console.error('[Push] Erro:', e.message);
    return false;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
}

function getToken() {
  try {
    const t = localStorage.getItem('access_token'); if (t) return t;
    const r = localStorage.getItem('rh-auth'); if (r) return JSON.parse(r)?.state?.token;
  } catch(e) {}
  return null;
}

// Auto-registar após login
window.addEventListener('DOMContentLoaded', () => {
  if (getToken()) setTimeout(registarPushNotifications, 2000);
});

window.nexPush = { registar: registarPushNotifications };
