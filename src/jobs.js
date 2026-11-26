'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { db, all, run, one, setting, num, DATA_DIR } = require('./db');
const L = require('./logic');
const bot = require('./bot');

const mark = (k, v) => run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);
const last = k => (one('SELECT value FROM settings WHERE key=?', k) || {}).value;

async function reminders() {
  const remindMs = num('remind_hours') * L.H, now = Date.now(), D = L.deadline();
  for (const l of all('SELECT * FROM lectures WHERE (video_at IS NULL OR q_at IS NULL)')) {
    const left = l.sent_at + D - now;
    if (left > 0 && left <= remindMs && !l.reminded) { run('UPDATE lectures SET reminded=1 WHERE id=?', l.id); await bot.remind(l, false); }
    if (left <= 0 && !l.late_alerted && !l.excused) { run('UPDATE lectures SET overdue_notified=1, late_alerted=1 WHERE id=?', l.id); await bot.lateAlert(l); }
  }
  // transfers nobody confirmed within 24h
  for (const t of all("SELECT t.id, u.name FROM transfer_msgs t JOIN users u ON u.id=t.user_id WHERE t.needs_confirm=1 AND t.confirmed_at IS NULL AND t.problem IS NULL AND t.reminded=0 AND t.created_at<?", now - L.DAY)) {
    run('UPDATE transfer_msgs SET reminded=1 WHERE id=?', t.id);
    await bot.sendAdmin(`⏳ ${t.name} لسه ماأكدش استلام التحويل من 24 ساعة.\nكلّمه من الحسابات (زرار الواتساب أو التليجرام).`);
  }
}
function dailySummaryText() {
  return L.dailyReportText(L.dailyReport({ role: 'admin', id: 0 })) + '\n\nالتفاصيل وبرومبت التحليل في اللوحة: التقارير.';
}
async function backup() {
  const file = path.join(DATA_DIR, `backup-${L.dayStr()}.db`);
  try { fs.rmSync(file, { force: true }); db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); } catch (e) { console.error('backup', e.message); return null; }
  const chat = process.env.BACKUP_CHAT_ID;
  if (chat) await bot.sendFile('sendDocument', 'document', chat, fs.readFileSync(file), path.basename(file), `نسخة احتياطية ${L.dayStr()}`);
  for (const f of fs.readdirSync(DATA_DIR).filter(f => /^backup-.*\.db$/.test(f)).sort().slice(0, -7)) fs.rmSync(path.join(DATA_DIR, f), { force: true });
  return file;
}
async function tick() {
  try {
    await reminders();
    const hm = L.localHM(), today = L.dayStr();
    if (hm >= setting('report_time') && last('last_report') !== today) { mark('last_report', today); await bot.sendAdmin(dailySummaryText()); }
    if (hm >= setting('backup_time') && last('last_backup') !== today) { mark('last_backup', today); await backup(); }
    run('DELETE FROM bot_pending WHERE created_at<?', Date.now() - 3 * L.DAY);
  } catch (e) { console.error('tick', e); }
}
function start() { setTimeout(tick, 5000); return setInterval(tick, 60e3); }
module.exports = { start, tick, backup, reminders, dailySummaryText };
