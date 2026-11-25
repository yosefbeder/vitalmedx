'use strict';
// يسجّل عنوان الـ Webhook عند تليجرام. شغّله مرة بعد التركيب:  docker compose exec app npm run set-webhook
const { BOT_TOKEN, PUBLIC_URL, WEBHOOK_SECRET } = process.env;
if (!BOT_TOKEN || !PUBLIC_URL || !WEBHOOK_SECRET) { console.error('لازم BOT_TOKEN و PUBLIC_URL و WEBHOOK_SECRET في ملف .env'); process.exit(1); }
const api = (m, b) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
(async () => {
  const url = `${PUBLIC_URL.replace(/\/$/, '')}/tg/${WEBHOOK_SECRET}`;
  console.log(await api('setWebhook', { url, secret_token: WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true }));
  console.log(await api('setMyCommands', { commands: [{ command: 'tasks', description: 'المحاضرات المفتوحة' }, { command: 'start', description: 'البداية' }] }));
  console.log(await api('getWebhookInfo', {}));
})();
