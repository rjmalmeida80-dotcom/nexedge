const fs = require('fs');
let c = fs.readFileSync('src/services/pushService.js', 'utf8');

// Adicionar require do web-push no topo
c = c.replace("'use strict';\n", `'use strict';
const webpush = require('web-push');

// Configurar VAPID keys
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.VAPID_EMAIL || 'suporte@nexedge.pt'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

`);

// Substituir o bloco de envio comentado pelo real
c = c.replace(
  `    // Enviar para cada subscription (sem web-push library por ora — apenas log)
    for (const sub of subs) {
      console.log(\`📱 [PUSH] Para: \${sub.utilizador_id} | \${titulo}\`);
      // Em produção: usar web-push library com VAPID keys
      // webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth }}, payload)
    }`,
  `    // Enviar para cada subscription via Web Push
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
        console.log(\`📱 [PUSH] Enviado para: \${sub.utilizador_id} | \${titulo}\`);
      } catch(pushErr) {
        console.error(\`📱 [PUSH] Erro para \${sub.utilizador_id}:\`, pushErr.message);
        // Remover subscription inválida (410 = Gone)
        if (pushErr.statusCode === 410) {
          await query('DELETE FROM push_subscription WHERE endpoint=$1', [sub.endpoint]).catch(() => {});
        }
      }
    }`
);

fs.writeFileSync('src/services/pushService.js', c);
console.log('OK — pushService.js actualizado com web-push real');
