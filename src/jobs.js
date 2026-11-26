'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { db, all, run, one, setting, num, DATA_DIR } = require('./db');
const L = require('./logic');
const bot = require('./bot');

const mark = (k, v) => run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);
const last = k => (one('SELECT value FROM settings WHERE key=?', k) || {}).value;

const once = key => run('INSERT OR IGNORE INTO alert_log(key,at) VALUES(?,?)', key, Date.now()).changes > 0;
// fire the latest threshold reached that wasn't sent yet (thresholds already passed are marked together → one message)
function stepHit(prefix, elapsed, list, unit) {
  const hit = list.filter(x => elapsed >= x * unit); let fresh = false;
  for (const x of hit) if (once(`${prefix}:${x}`)) fresh = true;
  return fresh ? hit.at(-1) : null;
}
const tgOf = id => (id ? (one('SELECT tg_id FROM users WHERE id=? AND active=1', id) || {}).tg_id : null);
let SILENT = false;
async function sendMany(chats, text) { if (SILENT) return; const seen = new Set(); for (const c of chats) if (c && !seen.has(String(c))) { seen.add(String(c)); await bot.send(c, text); } }
const csChats = () => all("SELECT tg_id FROM users WHERE role='cs' AND active=1 AND tg_id IS NOT NULL").map(x => x.tg_id);
const adminChats = () => [process.env.ADMIN_CHAT_ID, ...all("SELECT tg_id FROM users WHERE role='admin' AND active=1 AND tg_id IS NOT NULL").map(x => x.tg_id)];
const fmtT = t => new Intl.DateTimeFormat('ar-EG', { timeZone: L.TZ, hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'numeric' }).format(t);
async function reminders(silent = false) {
  SILENT = silent; try { await remindersInner(); } finally { SILENT = false; }
}
async function remindersInner() {
  const now = Date.now(), D = L.deadline(), M = 60e3;
  // doctor: reminders before the deadline (several, admin-defined), then one late alert per day of delay
  const before = L.numList('remind_before_hours');
  for (const l of all('SELECT * FROM lectures WHERE (video_at IS NULL OR q_at IS NULL)')) {
    const left = l.sent_at + D - now;
    if (left > 0) { const hit = before.filter(h => left <= h * L.H); let fresh = false; for (const h of hit) if (once(`rb:${l.id}:${h}`)) fresh = true; if (fresh && !SILENT) await bot.remind(l, false); }
    else if (!l.excused) { const day = Math.floor(-left / L.DAY) + 1; if (once(`late:${l.id}:${day}`)) { run('UPDATE lectures SET overdue_notified=1, late_alerted=1 WHERE id=?', l.id); if (!SILENT) await bot.lateAlert(l, day); } }
  }
  const bInfo = bid => one('SELECT b.code, b.coordinator_id, b.supervisor_id, c.name cn FROM batches b LEFT JOIN users c ON c.id=b.coordinator_id WHERE b.id=?', bid) || {};
  // coordinator: files approved but not uploaded
  const upLim = num('upload_minutes') * M, upList = L.numList('upload_alert_minutes');
  for (const l of all('SELECT * FROM lectures WHERE video_ok_at IS NOT NULL AND q_ok_at IS NOT NULL AND uploaded_at IS NULL')) {
    const el = now - Math.max(l.video_ok_at, l.q_ok_at), m = stepHit(`up:${l.id}`, el, upList, M); if (m == null) continue;
    const b = bInfo(l.batch_id), late = el > upLim;
    await sendMany([tgOf(b.coordinator_id), late && tgOf(b.supervisor_id)], `${late ? '⏰ متأخر: ' : '⏳ تذكير: '}محاضرة #${l.id} ${l.name} (دفعة ${b.code}) اتعتمدت من ${L.fmtDur(el)} ولسه مااترفعتش على Nerdio وقناة تليجرام.${late ? `\nالمسؤول: ${b.cn || '—'}. المشرف يقدر يسجّل الرفع بنفسه من اللوحة.` : ''}`);
  }
  // tickets
  const cLim = num('coord_reply_minutes') * M, csLim = num('cs_reply_minutes') * M;
  const sendList = L.numList('send_alert_minutes'), retList = L.numList('return_alert_minutes'), delList = L.numList('deliver_alert_minutes'), dueList = L.numList('due_alert_minutes');
  for (const t of all('SELECT * FROM tickets WHERE closed_at IS NULL')) {
    const b = bInfo(t.batch_id), head = `${t.kind === 'problem' ? 'المشكلة' : 'السؤال'} #${t.id} (دفعة ${b.code})${t.priority >= 2 ? ' 🔴' : ''}`;
    if (t.kind === 'question' && !t.sent_doctor_at) {
      const el = now - t.created_at, m = stepHit(`snd:${t.id}`, el, sendList, M);
      if (m != null) { const late = el > L.sendLim(); await sendMany([tgOf(b.coordinator_id), late && tgOf(b.supervisor_id)], `${late ? '⏰' : '⏳'} ${head} لسه مااتبعتش للدكتور من ${L.fmtDur(el)}.${late ? `\nالمسؤول: ${b.cn || '—'}. المشرف يقدر يبعته بنفسه.` : ''}`); }
    } else if (t.sent_doctor_at && !t.reply_at && !t.returned_at && !t.due_at) {
      const el = now - t.sent_doctor_at, m = stepHit(`drp:${t.id}`, el, L.numList('doctor_reply_alert_hours'), L.H);
      if (m != null) { const dn = (one('SELECT name FROM users WHERE id=?', t.doctor_id) || {}).name || 'الدكتور';
        await sendMany([tgOf(t.doctor_id)], `⏳ تذكير: ${t.kind === 'problem' ? 'المشكلة' : 'السؤال'} #${t.id}${t.priority >= 2 ? ' 🔴' : ''} مستني ردك من ${L.fmtDur(el)}.`);
        await sendMany([tgOf(b.coordinator_id)], `⏰ ${dn} مارد على ${head} من ${L.fmtDur(el)}.\nكلّمه من /msg.`); }
    } else if (t.reply_at && !t.returned_at && t.kind === 'question') {
      const el = now - t.reply_at, m = stepHit(`ret:${t.id}`, el, retList, M);
      if (m != null) { const late = el > cLim; await sendMany([tgOf(b.coordinator_id), late && tgOf(b.supervisor_id)], `${late ? '⏰' : '⏳'} الدكتور رد على ${head} من ${L.fmtDur(el)} والرد لسه مارجعش لخدمة العملاء.${late ? `\nالمسؤول: ${b.cn || '—'}. المشرف يقدر يرجّعه بنفسه.` : ''}`); }
    } else if (t.returned_at && !t.delivered_at) {
      const el = now - t.returned_at, m = stepHit(`dlv:${t.id}`, el, delList, M);
      if (m != null) { const late = el > csLim; await sendMany([...csChats(), ...(late ? adminChats() : [])], `${late ? '⏰' : '⏳'} الرد على ${head} رجع لخدمة العملاء من ${L.fmtDur(el)} ولسه ماوصلش للطالب.`); }
    }
    // the deadline CS chose for this ticket
    if (t.due_at) {
      const h = L.ticketHolder(t), holder = h === 'doctor' ? [tgOf(t.doctor_id)] : h === 'cs' ? csChats() : [tgOf(b.coordinator_id)];
      if (now < t.due_at) { const left = t.due_at - now, hit = dueList.filter(x => left <= x * M); let fresh = false; for (const x of hit) if (once(`due:${t.id}:${x}`)) fresh = true;
        if (fresh) await sendMany(holder, `⏳ ${h === 'doctor' ? `${t.kind === 'problem' ? 'المشكلة' : 'السؤال'} #${t.id}${t.priority >= 2 ? ' 🔴' : ''}` : head}: باقي ${L.fmtDur(left)} على المهلة المطلوبة للرد.`); }
      else if (once(`due:${t.id}:over`)) {
        const who = h === 'doctor' ? `الدكتور ${(one('SELECT name FROM users WHERE id=?', t.doctor_id) || {}).name || ''}` : h === 'cs' ? 'خدمة العملاء' : `المسؤول ${b.cn || ''}`;
        if (h === 'doctor') await sendMany(holder, `⚠️ ${t.kind === 'problem' ? 'المشكلة' : 'السؤال'} #${t.id} عدّى المهلة المطلوبة للرد. رد عليه دلوقتي.`);
        await sendMany([...(h === 'doctor' ? [] : holder), tgOf(b.coordinator_id), tgOf(b.supervisor_id), ...adminChats()], `⚠️ ${head} عدّى المهلة اللي اتحددت (${fmtT(t.due_at)}).\nواقف عند: ${who}`);
      }
    }
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
    if (!last('alerts_primed_v17')) { await reminders(true); mark('alerts_primed_v17', String(Date.now())); } // after upgrade: no burst for things already pending
    await reminders();
    const hm = L.localHM(), today = L.dayStr();
    if (hm >= setting('report_time') && last('last_report') !== today) { mark('last_report', today); await bot.sendAdmin(dailySummaryText()); }
    if (hm >= setting('backup_time') && last('last_backup') !== today) { mark('last_backup', today); await backup(); }
    run('DELETE FROM bot_pending WHERE created_at<?', Date.now() - 3 * L.DAY);
  } catch (e) { console.error('tick', e); }
}
function start() { setTimeout(tick, 5000); return setInterval(tick, 60e3); }
module.exports = { start, tick, backup, reminders, dailySummaryText };
