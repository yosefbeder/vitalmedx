'use strict';
const { one, all, run, setting, audit } = require('./db');
const L = require('./logic');

const API = (process.env.TG_API || 'https://api.telegram.org') + '/bot' + (process.env.BOT_TOKEN || 'missing');
const enabled = () => !!process.env.BOT_TOKEN;
const fmt = t => new Intl.DateTimeFormat('en-GB', { timeZone: L.TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
const money = n => (Math.round(n * 100) / 100).toLocaleString('en-US');

async function call(method, params) {
  if (!enabled()) return null;
  try {
    const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
    const j = await r.json();
    if (!j.ok) console.error('tg', method, j.description);
    return j.ok ? j.result : null;
  } catch (e) { console.error('tg', method, e.message); return null; }
}
async function sendFile(method, field, chat_id, buf, filename, caption, mime) {
  if (!enabled()) return null;
  try {
    const fd = new FormData();
    fd.append('chat_id', String(chat_id));
    if (caption) fd.append('caption', caption.slice(0, 1024));
    fd.append(field, new Blob([buf], { type: mime || 'application/octet-stream' }), filename);
    const r = await fetch(`${API}/${method}`, { method: 'POST', body: fd });
    const j = await r.json();
    if (!j.ok) console.error('tg', method, j.description);
    return j.ok ? j.result : null;
  } catch (e) { console.error('tg', method, e.message); return null; }
}
const send = (chat_id, text, extra = {}) => (chat_id ? call('sendMessage', { chat_id, text, ...extra }) : null);

function lectureText(l, title = 'محاضرة جديدة') {
  return `${title} #${l.id}\n${l.name}\nالنوع: ${L.TYPES[l.type]}\nالسعر: ${money(l.price)}\n${l.no_q ? 'المطلوب: فيديو الشرح بس (مفيش ملف أسئلة)' : 'المطلوب: فيديو الشرح + ملف الأسئلة'}\nآخر موعد: ${fmt(l.sent_at + L.deadline())}`;
}
async function sendLecture(l, files = []) {
  const d = one('SELECT tg_id FROM users WHERE id=?', l.doctor_id);
  if (!d || !d.tg_id) return false;
  await send(d.tg_id, lectureText(l));
  for (const f of files) {
    const r = await sendFile('sendDocument', 'document', d.tg_id, f.buf, f.name, f.label, f.mime);
    if (r && r.document) run(`UPDATE lectures SET ${f.field}=? WHERE id=?`, r.document.file_id, l.id);
  }
  return true;
}
async function notifyPriceChange(l, old) {
  const d = one('SELECT tg_id FROM users WHERE id=?', l.doctor_id);
  if (d && d.tg_id) await send(d.tg_id, `تعديل سعر المحاضرة #${l.id}\n${l.name}\nالسعر القديم: ${money(old)}\nالسعر الجديد: ${money(l.price)}`);
}
async function sendTicket(t) {
  const d = one('SELECT tg_id FROM users WHERE id=?', t.doctor_id);
  if (!d || !d.tg_id) return false;
  const lec = t.lecture_id ? one('SELECT name FROM lectures WHERE id=?', t.lecture_id) : null;
  const m = await send(d.tg_id, `سؤال من طالب #${t.id}${lec ? `\nعلى محاضرة: ${lec.name}` : ''}\n\n${t.body}\n\nاعمل Reply على الرسالة دي واكتب ردك.`, { reply_markup: { force_reply: true } });
  if (m) run('UPDATE tickets SET tg_msg_id=? WHERE id=?', m.message_id, t.id);
  return !!m;
}
async function notifyPenalty(p) {
  const u = one('SELECT tg_id FROM users WHERE id=?', p.user_id);
  if (u && u.tg_id) await send(u.tg_id, `قرار إداري\nالنوع: ${p.kind}${p.amount ? `\nالخصم: ${money(p.amount)}` : ''}\nالسبب: ${p.reason}\n\nتقدر تعترض من صفحتك في اللوحة.`);
}
async function remind(l, overdue) {
  const d = one('SELECT tg_id FROM users WHERE id=?', l.doctor_id);
  if (!d || !d.tg_id) return;
  const miss = [!l.video_at && 'الفيديو', !l.q_at && 'ملف الأسئلة'].filter(Boolean).join(' و');
  await send(d.tg_id, overdue ? `تنبيه: مهلة المحاضرة #${l.id} خلصت، والتأخير بيتسجل.\n${l.name}\nناقص: ${miss}` : `تذكير: باقي ${L.fmtDur(l.sent_at + L.deadline() - Date.now())} على تسليم المحاضرة #${l.id}\n${l.name}\nناقص: ${miss}`);
}
const adminChat = () => process.env.ADMIN_CHAT_ID;
const sendAdmin = text => send(adminChat(), text);

function openLectures(docId, field) {
  return all(`SELECT * FROM lectures WHERE doctor_id=? AND ${field} IS NULL ORDER BY queue_pos IS NULL, queue_pos, sent_at LIMIT 20`, docId);
}
function pickKeyboard(docId, kind, pendingId) {
  const field = kind === 'video' ? 'video_at' : 'q_at';
  const ls = openLectures(docId, field);
  return { ls, kb: { inline_keyboard: ls.map(l => [{ text: `#${l.id} ${l.name} · ${L.TYPES[l.type]}${L.isLate(null, l.sent_at, l.excused) ? ' · متأخر' : ''}`.slice(0, 60), callback_data: `p:${pendingId}:${l.id}` }]) } };
}

async function handleUpdate(u) {
  if (u.callback_query) return onCallback(u.callback_query);
  const m = u.message; if (!m || !m.chat) return;
  const chat = m.chat.id, from = String(m.from && m.from.id);
  const user = one('SELECT * FROM users WHERE tg_id=? AND active=1', from);
  const text = (m.text || '').trim();
  const code = /^VM-[A-Z0-9]{5}$/i.exec(text);
  if (code) {
    const target = one('SELECT * FROM users WHERE link_code=?', text.toUpperCase());
    if (!target) return send(chat, 'الكود ده مش صحيح. اتأكد منه وابعته تاني.');
    run('UPDATE users SET tg_id=NULL WHERE tg_id=?', from);
    run('UPDATE users SET tg_id=? WHERE id=?', from, target.id);
    audit(target.id, 'tg_link', { tg: from });
    return send(chat, `أهلاً ${target.name}، حسابك اتربط بالبوت بنجاح ✓${target.role === 'doctor' ? '\nهتوصلك المحاضرات هنا، وتقدر تبعت الفيديو وملف الأسئلة في أي وقت.\n/tasks لعرض مهامك' : ''}`);
  }
  if (!user) return send(chat, `أهلاً بيك في بوت ${setting('brand')}.\nابعت كود الربط اللي وصلك من الإدارة (بيبدأ بـ VM-).`);
  if (text === '/start') return send(chat, `أهلاً ${user.name} 👋\n/tasks لعرض المحاضرات المفتوحة`);
  if (user.role !== 'doctor') return send(chat, `أهلاً ${user.name}، حسابك مربوط بالبوت ✓\nالبوت بيستقبل الفيديوهات وملفات الأسئلة من حسابات الدكاترة بس.\nإرسال المحاضرات للدكاترة بيتم من لوحة التحكم، والبوت هيبعتلك هنا أي ملفات تطلبها من صفحة المحاضرة (زرار "ابعتلي الملفات على تليجرام").`);
  if (text === '/tasks') {
    const ls = all('SELECT * FROM lectures WHERE doctor_id=? AND (video_at IS NULL OR q_at IS NULL) ORDER BY queue_pos IS NULL, queue_pos, sent_at', user.id);
    if (ls.length) ls.forEach((l, i) => (l._n = i + 1));
    if (!ls.length) return send(chat, 'مفيش محاضرات مفتوحة دلوقتي ✓');
    return send(chat, 'المحاضرات بالترتيب اللي المفروض تبدأ بيه:\n\n' + ls.map(l => `${l._n}) #${l.id} ${l.name} (${L.TYPES[l.type]})\nناقص: ${[!l.video_at && 'فيديو', !l.q_at && 'أسئلة'].filter(Boolean).join(' + ')} · ${L.isLate(null, l.sent_at, l.excused) ? 'متأخر' : 'آخر موعد ' + fmt(l.sent_at + L.deadline())}`).join('\n\n'));
  }
  // reply to a student question
  const replyTo = m.reply_to_message && m.reply_to_message.message_id;
  let ticket = replyTo ? one('SELECT * FROM tickets WHERE tg_msg_id=? AND doctor_id=? AND reply_at IS NULL', replyTo, user.id) : null;
  if (!ticket && text && !m.video && !m.document) {
    const waiting = all('SELECT * FROM tickets WHERE doctor_id=? AND sent_doctor_at IS NOT NULL AND reply_at IS NULL', user.id);
    if (waiting.length === 1) ticket = waiting[0];
    else if (waiting.length > 1) return send(chat, 'عندك أكتر من سؤال مستني رد. اعمل Reply على رسالة السؤال نفسها واكتب ردك.');
  }
  if (ticket && text) {
    run('UPDATE tickets SET reply=?, reply_at=? WHERE id=?', text, Date.now(), ticket.id);
    return send(chat, `تم تسجيل ردك على السؤال #${ticket.id} ✓`);
  }
  // files
  let kind = null, fileId = null;
  if (m.video) { kind = 'video'; fileId = m.video.file_id; }
  else if (m.document) { const mime = m.document.mime_type || ''; kind = mime.startsWith('video/') ? 'video' : 'q'; fileId = m.document.file_id; }
  if (kind) {
    const p = run('INSERT INTO bot_pending(tg_id,kind,file_id,created_at) VALUES(?,?,?,?)', from, kind, fileId, Date.now());
    const { ls, kb } = pickKeyboard(user.id, kind, Number(p.lastInsertRowid));
    const what = kind === 'video' ? 'الفيديو' : 'ملف الأسئلة';
    if (!ls.length) return send(chat, `استلمت ${what}، بس مفيش محاضرات مستنية ${what} منك دلوقتي.`);
    return send(chat, `استلمت ${what}. يخص أنهي محاضرة؟`, { reply_markup: kb });
  }
  return send(chat, 'ابعت الفيديو أو ملف الأسئلة، أو اعمل Reply على سؤال الطالب. /tasks لعرض مهامك.');
}
async function onCallback(q) {
  const from = String(q.from.id), chat = q.message && q.message.chat.id;
  const m = /^p:(\d+):(\d+)$/.exec(q.data || '');
  const user = one("SELECT * FROM users WHERE tg_id=? AND role='doctor' AND active=1", from);
  if (!m || !user) return call('answerCallbackQuery', { callback_query_id: q.id });
  const p = one('SELECT * FROM bot_pending WHERE id=? AND tg_id=?', Number(m[1]), from);
  const l = one('SELECT * FROM lectures WHERE id=? AND doctor_id=?', Number(m[2]), user.id);
  if (!p || !l) { await call('answerCallbackQuery', { callback_query_id: q.id, text: 'الطلب ده انتهى' }); return; }
  const [fileCol, atCol, what] = p.kind === 'video' ? ['video_file', 'video_at', 'الفيديو'] : ['q_file', 'q_at', 'ملف الأسئلة'];
  if (l[atCol]) { await call('answerCallbackQuery', { callback_query_id: q.id, text: 'اتسلم قبل كده' }); return; }
  const at = Date.now();
  run(`UPDATE lectures SET ${fileCol}=?, ${atCol}=? WHERE id=?`, p.file_id, at, l.id);
  run('DELETE FROM bot_pending WHERE id=?', p.id);
  audit(user.id, 'deliver', { lecture: l.id, kind: p.kind });
  await call('answerCallbackQuery', { callback_query_id: q.id, text: 'تم ✓' });
  const late = at - l.sent_at > L.deadline();
  const txt = `تم ربط ${what} بالمحاضرة #${l.id} ✓\n${l.name}\nوقت الاستلام: ${fmt(at)} · ${late ? 'متأخر، والتأخير اتسجل' : 'في الموعد'}`;
  if (chat && q.message) await call('editMessageText', { chat_id: chat, message_id: q.message.message_id, text: txt });
  else await send(chat, txt);
}
async function getFileUrl(fileId) { const f = await call('getFile', { file_id: fileId }); return f ? `${(process.env.TG_API || 'https://api.telegram.org')}/file/bot${process.env.BOT_TOKEN}/${f.file_path}` : null; }
async function forwardFile(chat_id, fileId, kind, caption) { return call(kind === 'video' ? 'sendVideo' : 'sendDocument', { chat_id, [kind === 'video' ? 'video' : 'document']: fileId, caption }); }

module.exports = { call, send, sendFile, sendLecture, sendTicket, notifyPenalty, notifyPriceChange, remind, sendAdmin, handleUpdate, enabled, fmt, money, forwardFile, getFileUrl };
