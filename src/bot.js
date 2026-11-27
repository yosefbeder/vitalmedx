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
async function sendFile(method, field, chat_id, buf, filename, caption, mime, replyTo, markup) {
  if (!enabled()) return null;
  try {
    const fd = new FormData();
    fd.append('chat_id', String(chat_id));
    if (caption) fd.append('caption', caption.slice(0, 1024));
    if (replyTo) fd.append('reply_to_message_id', String(replyTo));
    if (markup) fd.append('reply_markup', JSON.stringify(markup));
    fd.append(field, new Blob([buf], { type: mime || 'application/octet-stream' }), filename);
    const r = await fetch(`${API}/${method}`, { method: 'POST', body: fd });
    const j = await r.json();
    if (!j.ok) console.error('tg', method, j.description);
    return j.ok ? j.result : null;
  } catch (e) { console.error('tg', method, e.message); return null; }
}
const send = (chat_id, text, extra = {}) => (chat_id ? call('sendMessage', { chat_id, text, ...extra }) : null);

const coversNames = l => { try { const ids = JSON.parse(l.covers || '[]'); return ids.length ? all(`SELECT name FROM lectures WHERE id IN (${ids.map(Number).join(',')}) ORDER BY sent_at`).map(x => x.name) : []; } catch { return []; } };
function lectureText(l, title) {
  const cv = coversNames(l); title = title || (l.type === 'revision' ? '📚 مراجعة جديدة' : 'محاضرة جديدة');
  return `${title} #${l.id}\n${l.name}${cv.length ? `\nعلى المحاضرات: ${cv.join('، ')}` : ''}\nالنوع: ${L.typeLabel(l)}\nالسعر: ${money(l.price)}\n${l.no_q ? 'المطلوب: فيديو الشرح بس (مفيش ملف أسئلة)' : 'المطلوب: فيديو الشرح + ملف الأسئلة'}\nآخر موعد: ${fmt(l.sent_at + L.deadline())}`;
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
  const m = await send(d.tg_id, `${t.priority >= 2 ? '🔴 مستعجل – لازم يترد عليه على طول\n' : ''}${t.kind === 'problem' ? 'مشكلة' : 'سؤال'} من طالب #${t.id}${lec ? `\nعلى محاضرة: ${lec.name}` : ''}${t.due_at ? `\nمطلوب الرد قبل: ${fmt(t.due_at)}` : ''}\n\n${t.body}${t.att_path ? '\n\n(السؤال مبعوت كمان كملف تحت الرسالة دي)' : ''}\n\nاعمل Reply على الرسالة دي واكتب ردك أو ابعته ريكورد.`, { reply_markup: { force_reply: true } });
  if (!m) return false;
  run('UPDATE tickets SET tg_msg_id=? WHERE id=?', m.message_id, t.id);
  if (t.att_file_id && !t.att_path) { const r = await sendByKind(d.tg_id, t.att_kind || 'document', t.att_file_id, `سؤال #${t.id}`, { reply_to_message_id: m.message_id }); if (r) run('UPDATE tickets SET att_msg_id=? WHERE id=?', r.message_id, t.id); }
  else if (t.att_path && require('node:fs').existsSync(t.att_path)) {
    const mime = t.att_mime || '', [method, field] = /ogg|opus/.test(mime) ? ['sendVoice', 'voice'] : mime.startsWith('audio/') ? ['sendAudio', 'audio'] : mime.startsWith('image/') ? ['sendPhoto', 'photo'] : mime.startsWith('video/') ? ['sendVideo', 'video'] : ['sendDocument', 'document'];
    const r = await sendFile(method, field, d.tg_id, require('node:fs').readFileSync(t.att_path), t.att_name || 'file', `سؤال #${t.id}`, mime, m.message_id);
    if (r) { const f = r.voice || r.audio || r.video || r.document || (r.photo && r.photo.at(-1)); run('UPDATE tickets SET att_msg_id=?, att_file_id=? WHERE id=?', r.message_id, f ? f.file_id : null, t.id); }
  }
  await sendParts(d.tg_id, t, m.message_id, true);
  return true;
}
// the rest of a question sent in several messages
async function sendPart(chat, t, p, replyTo, label = 'تكملة') {
  const cap = `${label} السؤال #${t.id}${p.body ? `:\n${p.body}` : ''}`, ex = replyTo ? { reply_to_message_id: replyTo } : {};
  if (p.file_id && p.file_kind !== 'video_note') return sendByKind(chat, p.file_kind, p.file_id, cap.slice(0, 1000), ex);
  if (p.path && require('node:fs').existsSync(p.path)) { const mime = p.mime || '', [mt, f] = /ogg|opus/.test(mime) && !/webm/.test(mime) ? ['sendVoice', 'voice'] : mime.startsWith('audio/') ? ['sendAudio', 'audio'] : mime.startsWith('image/') ? ['sendPhoto', 'photo'] : mime.startsWith('video/') ? ['sendVideo', 'video'] : ['sendDocument', 'document']; return sendFile(mt, f, chat, require('node:fs').readFileSync(p.path), p.name || 'file', cap.slice(0, 1000), mime, replyTo); }
  if (p.file_id) { const r = await sendByKind(chat, p.file_kind, p.file_id, '', ex); if (!p.body) return r; }
  return send(chat, cap, ex);
}
async function sendParts(chat, t, replyTo, toDoctor) {
  for (const p of all('SELECT * FROM ticket_parts WHERE ticket_id=? ORDER BY id', t.id)) { const r = await sendPart(chat, t, p, replyTo); if (toDoctor && r && r.message_id) run('UPDATE ticket_parts SET tg_msg_id=? WHERE id=?', r.message_id, p.id); }
}
// something added after the question was sent (CS replied on the confirmation, or from the dashboard)
async function addPart(t, user, part) {
  if (t.reply_at || t.closed_at) return { ok: false, msg: `السؤال #${t.id} اترد عليه خلاص. لو ده سؤال جديد ابعته من غير Reply.` };
  const r = run('INSERT INTO ticket_parts(ticket_id,body,file_id,file_kind,path,mime,name,by,created_at) VALUES(?,?,?,?,?,?,?,?,?)', t.id, part.body || null, part.file_id || null, part.file_kind || null, part.path || null, part.mime || null, part.name || null, user.id, Date.now());
  const p = one('SELECT * FROM ticket_parts WHERE id=?', Number(r.lastInsertRowid));
  const c = one('SELECT u.tg_id FROM batches b JOIN users u ON u.id=b.coordinator_id WHERE b.id=?', t.batch_id) || {};
  if (t.sent_doctor_at && t.doctor_id) {
    const d = one('SELECT tg_id FROM users WHERE id=?', t.doctor_id) || {};
    if (d.tg_id) { const m = await sendPart(d.tg_id, t, p, t.tg_msg_id, '➕ إضافة على'); if (m && m.message_id) run('UPDATE ticket_parts SET tg_msg_id=? WHERE id=?', m.message_id, p.id); }
    if (c.tg_id) await send(c.tg_id, `➕ اتضاف جزء جديد على السؤال #${t.id}${p.body ? `: ${p.body.slice(0, 200)}` : ''}`);
  } else if (c.tg_id) await sendPart(c.tg_id, t, p, null, '➕ إضافة على');
  audit(user.id, 'ticket_add_part', { id: t.id });
  return { ok: true, msg: `اتضافت على السؤال #${t.id} ✓` };
}
const KIND_SEND = { voice: ['sendVoice', 'voice'], audio: ['sendAudio', 'audio'], photo: ['sendPhoto', 'photo'], video: ['sendVideo', 'video'], video_note: ['sendVideoNote', 'video_note'], document: ['sendDocument', 'document'] };
const sendByKind = (chat_id, kind, file_id, caption, extra = {}) => { const [m, f] = KIND_SEND[kind] || KIND_SEND.document; return call(m, { chat_id, [f]: file_id, ...(kind === 'video_note' ? {} : { caption }), ...extra }); };
const KIND_MIME = { voice: 'audio/ogg', audio: 'audio/mpeg', photo: 'image/jpeg', video: 'video/mp4', video_note: 'video/mp4', document: 'application/octet-stream' };
function msgContent(m) {
  if (m.voice) return ['voice', m.voice.file_id]; if (m.audio) return ['audio', m.audio.file_id]; if (m.photo) return ['photo', m.photo.at(-1).file_id];
  if (m.video) return ['video', m.video.file_id]; if (m.video_note) return ['video_note', m.video_note.file_id]; if (m.document) return ['document', m.document.file_id]; return null;
}
const prioLine = t => `${t.priority >= 2 ? `🔴 ${L.PRIORITY[t.priority]}` : `الأولوية: ${L.PRIORITY[t.priority ?? 1]}`}${t.due_at ? ` · مطلوب الرد قبل ${fmt(t.due_at)}` : ''}`;
const tkHead = t => { const b = one('SELECT code FROM batches WHERE id=?', t.batch_id) || {}; const l = t.lecture_id ? one('SELECT name FROM lectures WHERE id=?', t.lecture_id) : null; return `دفعة ${b.code || ''}${l ? ` · ${l.name}` : ''}${t.student ? `\nالطالب: ${t.student}` : ''}\n${prioLine(t)}`; };
async function sendAtt(chat, t, caption, extra) {
  if (t.att_file_id) return sendByKind(chat, t.att_kind || 'document', t.att_file_id, caption, extra);
  if (t.att_path && require('node:fs').existsSync(t.att_path)) return sendFile('sendDocument', 'document', chat, require('node:fs').readFileSync(t.att_path), t.att_name || 'file', caption, t.att_mime);
}
async function notifyCoordNew(t) {
  const c = one('SELECT u.tg_id FROM batches b JOIN users u ON u.id=b.coordinator_id WHERE b.id=?', t.batch_id);
  if (!c || !c.tg_id) return;
  if (one('SELECT 1 FROM ticket_parts WHERE ticket_id=?', t.id)) await sendParts(c.tg_id, t, null, false);
  if (t.kind === 'problem') { await send(c.tg_id, `مشكلة جديدة #${t.id}\n${tkHead(t)}\n\n${t.body}`, { reply_markup: { inline_keyboard: [[{ text: 'اتحلت ✓', callback_data: `tp:${t.id}` }]] } }); if (t.att_file_id || t.att_path) await sendAtt(c.tg_id, t, `مرفق المشكلة #${t.id}`); return; }
  const docs = [];
  if (t.lecture_id) { const d = one('SELECT u.id, u.name FROM lectures l JOIN users u ON u.id=l.doctor_id WHERE l.id=?', t.lecture_id); if (d) docs.push(d); }
  for (const d of all("SELECT DISTINCT u.id, u.name FROM lectures l JOIN users u ON u.id=l.doctor_id WHERE l.batch_id=? AND u.active=1 ORDER BY l.sent_at DESC LIMIT 12", t.batch_id)) if (!docs.some(x => x.id === d.id)) docs.push(d);
  if (!docs.length) for (const d of all("SELECT id, name FROM users WHERE role='doctor' AND active=1 ORDER BY name LIMIT 30")) docs.push(d);
  await send(c.tg_id, `سؤال جديد من خدمة العملاء #${t.id}\n${tkHead(t)}\n\n${t.body}\n\nتقدر ترد بنفسك، أو تبعته لدكتور:`, { reply_markup: { inline_keyboard: [[{ text: '✍️ هرد أنا', callback_data: `tsr:${t.id}` }], ...docs.map((d, i) => [{ text: `${i === 0 && t.lecture_id ? '⭐ ' : ''}${d.name}`, callback_data: `td:${t.id}:${d.id}` }])] } });
  if (t.att_file_id || t.att_path) await sendAtt(c.tg_id, t, `السؤال #${t.id}`);
}
async function notifyCoordDirect(t) {
  const c = one('SELECT u.tg_id FROM batches b JOIN users u ON u.id=b.coordinator_id WHERE b.id=?', t.batch_id), d = one('SELECT name FROM users WHERE id=?', t.doctor_id) || {};
  if (c && c.tg_id) await sendParts(c.tg_id, t, null, false);
  if (c && c.tg_id) await send(c.tg_id, `سؤال اتبعت مباشرة لـ ${d.name} #${t.id}\n${tkHead(t)}\n\n${t.body}\n\nانت بتتابع بس: الرد هيروح لخدمة العملاء على طول، ولو الدكتور اتأخر هيجيلك تنبيه. تقدر تكلمه من /msg.`);
}
async function notifyCoordReply(t) {
  const c = one('SELECT u.tg_id FROM batches b JOIN users u ON u.id=b.coordinator_id WHERE b.id=?', t.batch_id);
  if (!c || !c.tg_id) return;
  const d = one('SELECT name FROM users WHERE id=?', t.doctor_id) || {};
  const kb = { reply_markup: { inline_keyboard: [[{ text: 'رجّعه لخدمة العملاء', callback_data: `tr:${t.id}` }]] } };
  if (t.reply_path && !t.reply_file_id && require('node:fs').existsSync(t.reply_path)) { // doctor replied from the dashboard with a file
    const mime = t.reply_mime || '', [method, field] = /ogg|opus/.test(mime) && !/webm/.test(mime) ? ['sendVoice', 'voice'] : /mpeg|mp4a|m4a|aac/.test(mime) ? ['sendAudio', 'audio'] : mime.startsWith('image/') ? ['sendPhoto', 'photo'] : ['sendDocument', 'document'];
    const r = await sendFile(method, field, c.tg_id, require('node:fs').readFileSync(t.reply_path), t.reply_name || 'reply', `رد الدكتور على #${t.id}`, mime);
    const f = r && (r.voice || r.audio || r.document || (r.photo && r.photo.at(-1)));
    if (f) { run('UPDATE tickets SET reply_file_id=?, reply_kind=? WHERE id=?', f.file_id, field, t.id); t = { ...t, reply_file_id: f.file_id, reply_kind: field, _sentFile: true }; }
  }
  await send(c.tg_id, `${d.name || 'الدكتور'} رد على السؤال #${t.id}\n${tkHead(t)}\n\nالسؤال: ${t.body}\n\nالرد: ${t.reply}${t.reply_file_id ? '\n(الرد الصوتي/الملف تحت الرسالة دي)' : ''}\n\nمعاك ${setting('coord_reply_minutes')} دقيقة ترجّعه.`, t.reply_file_id ? {} : kb);
  if (t.reply_file_id && !t._sentFile) await sendByKind(c.tg_id, t.reply_kind, t.reply_file_id, `رد الدكتور على #${t.id}`, kb);
}
async function ensureReplyFile(t, chat) { // a dashboard reply file → upload once to get a telegram file id
  if (t.reply_file_id || !t.reply_path || !require('node:fs').existsSync(t.reply_path)) return t;
  const mime = t.reply_mime || '', [method, field] = /ogg|opus/.test(mime) && !/webm/.test(mime) ? ['sendVoice', 'voice'] : /mpeg|mp4a|m4a|aac/.test(mime) ? ['sendAudio', 'audio'] : mime.startsWith('image/') ? ['sendPhoto', 'photo'] : ['sendDocument', 'document'];
  const r = await sendFile(method, field, chat, require('node:fs').readFileSync(t.reply_path), t.reply_name || 'reply', `رد على السؤال #${t.id}`, mime);
  const f = r && (r.voice || r.audio || r.document || (r.photo && r.photo.at(-1)));
  if (f) { run('UPDATE tickets SET reply_file_id=?, reply_kind=? WHERE id=?', f.file_id, field, t.id); return { ...t, reply_file_id: f.file_id, reply_kind: field, _sentTo: String(chat) }; }
  return t;
}
// doctor (or coordinator on his behalf) replied → straight to customer service; the coordinator just follows
async function afterDoctorReply(t) {
  if (!t.returned_at) { run('UPDATE tickets SET returned_at=? WHERE id=? AND returned_at IS NULL', t.reply_at || Date.now(), t.id); t = one('SELECT * FROM tickets WHERE id=?', t.id); }
  await notifyCsReturn(t);
  const c = one('SELECT u.tg_id FROM batches b JOIN users u ON u.id=b.coordinator_id WHERE b.id=?', t.batch_id), d = one('SELECT name FROM users WHERE id=?', t.doctor_id) || {};
  if (c && c.tg_id) await send(c.tg_id, `✓ ${d.name || 'الدكتور'} رد على ${t.kind === 'problem' ? 'المشكلة' : 'السؤال'} #${t.id}، والرد راح لخدمة العملاء.\n${tkHead(t)}\n\nالرد: ${t.reply || ''}`);
}
async function notifyCsReturn(t) {
  const kb = { reply_markup: { inline_keyboard: [[{ text: 'اتبعت للطالب ✓', callback_data: `tc:${t.id}` }]] } };
  for (const c of all("SELECT tg_id FROM users WHERE role='cs' AND active=1 AND tg_id IS NOT NULL")) {
    t = await ensureReplyFile(t, c.tg_id);
    await send(c.tg_id, `رد جاهز للطالب #${t.id}\n${tkHead(t)}\n\nالسؤال: ${t.body}\n\nالرد: ${t.reply}${t.reply_file_id ? '\n(الرد الصوتي/الملف تحت الرسالة دي، اعمله Forward للطالب)' : ''}\n\nمعاك ${setting('cs_reply_minutes')} دقيقة.`, t.reply_file_id ? {} : kb);
    if (t.reply_file_id && t._sentTo !== String(c.tg_id)) await sendByKind(c.tg_id, t.reply_kind, t.reply_file_id, `رد على السؤال #${t.id}`, kb);
  }
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
async function lateAlert(l, day = 1) {
  const b = one('SELECT b.code, c.name cn, c.tg_id ct, s.name sn, s.tg_id st FROM batches b LEFT JOIN users c ON c.id=b.coordinator_id LEFT JOIN users s ON s.id=b.supervisor_id WHERE b.id=?', l.batch_id) || {};
  const d = one('SELECT name FROM users WHERE id=?', l.doctor_id) || {};
  const miss = [!l.video_at && 'الفيديو', !l.q_at && 'ملف الأسئلة'].filter(Boolean).join(' و');
  const txt = `${day > 1 ? `⚠️ لسه متأخرة (اليوم ${day} من التأخير): ` : '⚠️ تأخير: '}${d.name || 'الدكتور'} اتأخر عن محاضرة ${l.name} – دفعة ${b.code || ''}\nمتأخرة من ${L.fmtDur(Date.now() - l.sent_at - L.deadline())} · ناقص: ${miss}\nاتبعتت: ${fmt(l.sent_at)} · الديدلاين: ${fmt(l.sent_at + L.deadline())}\nالمسؤول: ${b.cn || '—'} · المشرف: ${b.sn || '—'}`;
  const sent = new Set();
  const to = async chat => { if (!chat || sent.has(String(chat))) return; sent.add(String(chat)); await send(chat, txt); };
  await remind(l, true); // the doctor gets his own message (no batch/university info)
  await to(b.ct); await to(b.st);
  if (adminChat()) await to(adminChat());
  for (const a of all("SELECT tg_id FROM users WHERE role='admin' AND active=1 AND tg_id IS NOT NULL")) await to(a.tg_id);
  return txt;
}
const adminChat = () => process.env.ADMIN_CHAT_ID;
async function sendAdmin(text) { const sent = new Set(); if (adminChat()) { sent.add(String(adminChat())); await send(adminChat(), text); } for (const a of all("SELECT tg_id FROM users WHERE role='admin' AND active=1 AND tg_id IS NOT NULL")) if (!sent.has(String(a.tg_id))) { sent.add(String(a.tg_id)); await send(a.tg_id, text); } }

function openLectures(docId, field) {
  return all(`SELECT * FROM lectures WHERE doctor_id=? AND ${field} IS NULL ORDER BY queue_pos IS NULL, queue_pos, sent_at LIMIT 20`, docId);
}
function pickKeyboard(docId, kind, pendingId) {
  const field = kind === 'video' ? 'video_at' : 'q_at';
  const ls = openLectures(docId, field);
  return { ls, kb: { inline_keyboard: ls.map(l => [{ text: `#${l.id} ${l.name} · ${L.typeLabel(l)}${L.isLate(null, l.sent_at, l.excused) ? ' · متأخر' : ''}`.slice(0, 60), callback_data: `p:${pendingId}:${l.id}` }]) } };
}

const queues = new Map(); // one update at a time per chat (forwarded batches arrive together)
function handleUpdateQueued(u) {
  const m = u.message || (u.callback_query && u.callback_query.message), key = String(m && m.chat ? m.chat.id : u.callback_query ? u.callback_query.from.id : 0);
  const p = (queues.get(key) || Promise.resolve()).then(() => handleUpdate(u)).catch(e => console.error('update', e));
  queues.set(key, p); p.finally(() => { if (queues.get(key) === p) queues.delete(key); }); return p;
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
  if (text === '/start') return send(chat, `أهلاً ${user.name} 👋\nاكتب /menu عشان تشوف كل اللي تقدر تعمله من هنا.`);
  // problem with a transfer (after pressing "فيه مشكلة")
  const rTo = m.reply_to_message && m.reply_to_message.message_id;
  const trp = (rTo && one('SELECT * FROM transfer_msgs WHERE user_id=? AND problem_msg_id=?', user.id, rTo)) || (!rTo && text && !text.startsWith('/') && one('SELECT * FROM transfer_msgs WHERE user_id=? AND problem_wait>? AND problem IS NULL ORDER BY id DESC', user.id, Date.now() - 30 * 60e3));
  if (trp && text) return recordTransferProblem(trp, user, text, chat);
  const mc = msgContent(m);
  // coordinator answering a question himself
  if (rTo) { const tq = one('SELECT * FROM tickets WHERE cr_msg_id=? AND reply_at IS NULL', rTo);
    if (tq && (text || mc)) { const n = Date.now(); run('UPDATE tickets SET reply=?, reply_at=?, reply_file_id=?, reply_kind=?, replied_by=?, returned_at=?, returned_by=? WHERE id=?', text || m.caption || '[رد صوتي/ملف]', n, mc ? mc[1] : null, mc ? mc[0] : null, user.id, n, user.id, tq.id);
      audit(user.id, 'ticket_self_reply', { id: tq.id }); await notifyCsReturn(one('SELECT * FROM tickets WHERE id=?', tq.id)); return send(chat, `ردك على #${tq.id} راح لخدمة العملاء ✓`); } }
  // reply to a chat message → back to the sender
  if (rTo) { const cmsg = one('SELECT * FROM messages WHERE tg_msg_id=? AND to_id=?', rTo, user.id);
    if (cmsg && (text || mc)) { const to = one('SELECT * FROM users WHERE id=? AND active=1', cmsg.from_id); if (to) { await require('./actions').sendChat(user, to, { body: text || m.caption || '', file: mc ? { file_id: mc[1], kind: mc[0] } : null }); return send(chat, `اتبعتت لـ ${to.name} ✓`); } } }
  if (text === '/menu' || text === 'menu' || text === 'القائمة') return showMenu(chat, user);
  if (text === '/msg') return chatPicker(chat, user);
  if (text === '/new' && ['admin', 'coordinator', 'supervisor'].includes(user.role)) return newFlowStart(chat, user, from);
  if (text === '/cancel' || text === '/stop') { run('DELETE FROM bot_flows WHERE tg_id=?', from); return send(chat, 'اتلغى ✓'); }
  const fl = one('SELECT * FROM bot_flows WHERE tg_id=? AND at>?', from, Date.now() - 20 * 60e3);
  if (fl && !text.startsWith('/')) { const r = await onFlowInput(fl, m, user, chat, from, text, mc); if (r !== false) return r; }
  if (user.role === 'cs' || (user.role === 'admin' && !text.startsWith('/'))) {
    const c0 = msgContent(m), body0 = (text || m.caption || '').trim();
    // Reply on "السؤال اتسجل #.." → add to that question
    if (rTo && (c0 || body0)) { const tk = one('SELECT * FROM tickets WHERE cs_msg_id=? AND created_by=? ORDER BY id DESC', rTo, user.id); if (tk) { const r = await addPart(tk, user, { body: body0, file_id: c0 && c0[1], file_kind: c0 && c0[0] }); return send(chat, r.msg); } }
    // a question still being filled in (last 15 min): more messages join it
    const cur = one('SELECT * FROM bot_drafts WHERE tg_id=? AND created_at>? ORDER BY id DESC', from, Date.now() - 15 * 60e3);
    if (cur && (c0 || body0)) {
      if (cur.await_student && text && !c0 && text.length <= 120) { run('UPDATE bot_drafts SET student=?, await_student=0 WHERE id=?', text, cur.id); return askPriority(null, chat, cur.id); }
      const ex = JSON.parse(cur.extra || '[]'); ex.push({ body: body0 || null, file_id: c0 ? c0[1] : null, file_kind: c0 ? c0[0] : null });
      run('UPDATE bot_drafts SET extra=?, created_at=? WHERE id=?', JSON.stringify(ex), Date.now(), cur.id);
      return send(chat, `اتضافت للسؤال ✓ (${ex.length + 1} رسايل). كمّل الاختيار من الأزرار اللي فوق.`);
    }
    // older unfinished ones: save those that have a batch with defaults, drop the rest
    for (const old of all('SELECT * FROM bot_drafts WHERE tg_id=? ORDER BY id', from)) { if (old.batch_id) await createFromDraft(null, chat, user, old); else run('DELETE FROM bot_drafts WHERE id=?', old.id); }
  }
  if (user.role === 'cs' || (user.role === 'admin' && !text.startsWith('/'))) {
    const c = msgContent(m), body = (text || m.caption || '').trim();
    if (!c && !body) return send(chat, 'ابعت سؤال الطالب هنا (نص أو ريكورد أو صورة)، وأنا هوصّله لمسؤول الدفعة.');
    const r = run('INSERT INTO bot_drafts(tg_id,body,file_id,file_kind,created_at) VALUES(?,?,?,?,?)', from, body || null, c ? c[1] : null, c ? c[0] : null, Date.now());
    return send(chat, 'تمام. ده سؤال لدكتور ولا مشكلة؟', { reply_markup: { inline_keyboard: [[{ text: 'سؤال لدكتور', callback_data: `k:${r.lastInsertRowid}:question` }, { text: 'مشكلة', callback_data: `k:${r.lastInsertRowid}:problem` }]] } });
  }
  if (user.role !== 'doctor') return showMenu(chat, user, `أهلاً ${user.name} 👋 ده اللي تقدر تعمله من البوت:`);
  if (text === '/tasks') return send(chat, tasksText(user));
  // reply to a student question
  const replyTo = m.reply_to_message && m.reply_to_message.message_id;
  let ticket = replyTo ? one('SELECT * FROM tickets WHERE (tg_msg_id=? OR att_msg_id=? OR id IN (SELECT ticket_id FROM ticket_parts WHERE tg_msg_id=?)) AND doctor_id=? AND reply_at IS NULL', replyTo, replyTo, replyTo, user.id) : null;
  const rf = m.voice ? ['voice', m.voice.file_id] : m.audio ? ['audio', m.audio.file_id] : m.video_note ? ['video_note', m.video_note.file_id] : m.photo ? ['photo', m.photo.at(-1).file_id] : (ticket && m.video) ? ['video', m.video.file_id] : (ticket && m.document) ? ['document', m.document.file_id] : null;
  if (!ticket && (text || (rf && !m.video && !m.document)) && !m.video && !m.document) {
    const waiting = all('SELECT * FROM tickets WHERE doctor_id=? AND sent_doctor_at IS NOT NULL AND reply_at IS NULL', user.id);
    if (waiting.length === 1) ticket = waiting[0];
    else if (waiting.length > 1) return send(chat, 'عندك أكتر من سؤال مستني رد. اعمل Reply على رسالة السؤال نفسها واكتب ردك.');
  }
  if (ticket && (text || rf)) {
    const label = { voice: '[رد صوتي]', audio: '[رد صوتي]', video_note: '[رد فيديو]', photo: '[رد صورة]', video: '[رد فيديو]', document: '[رد ملف]' };
    run('UPDATE tickets SET reply=?, reply_at=?, reply_file_id=?, reply_kind=? WHERE id=?', text || m.caption || label[rf[0]], Date.now(), rf ? rf[1] : null, rf ? rf[0] : null, ticket.id);
    afterDoctorReply(one('SELECT * FROM tickets WHERE id=?', ticket.id)).catch(e => console.error('notify', e));
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
  if (rf) return send(chat, 'لو ده رد على سؤال طالب، اعمل Reply على رسالة السؤال نفسها وابعته تاني.');
  return send(chat, 'ابعت الفيديو أو ملف الأسئلة، أو اعمل Reply على سؤال الطالب. /tasks لعرض مهامك.');
}
async function onCallback(q) {
  const from = String(q.from.id), chat = q.message && q.message.chat.id;
  if (/^(k|tb|tl|tto|ts|tg|tga|tq|tpr|tdl|td|tr|tc|tp|tsr):/.test(q.data || '')) return onTicketCallback(q, from, chat);
  if (/^(mn|nf|cm|ap|upl|ck|ex|sb|pa):/.test(q.data || '')) return onFlowCallback(q, from, chat);
  if (/^(rc|rx):/.test(q.data || '')) return onTransferCallback(q, from, chat);
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
const ans = (q, text) => call('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) });
const editMsg = (q, text) => (q.message ? call('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).then(() => send(q.message.chat.id, text)) : null);
async function onTicketCallback(q, from, chat) {
  const user = one('SELECT * FROM users WHERE tg_id=? AND active=1', from); if (!user) return ans(q);
  const [k, a, b] = q.data.split(':'); const n = Date.now();
  if (['k', 'tb', 'tl', 'tto', 'ts', 'tg', 'tga', 'tq', 'tpr', 'tdl'].includes(k)) {
    if (!['cs', 'admin'].includes(user.role)) return ans(q, 'مش مسموح');
    const dr = one('SELECT * FROM bot_drafts WHERE id=? AND tg_id=?', Number(a), from); if (!dr) return ans(q, 'الطلب ده انتهى، ابعت السؤال تاني');
    if (k === 'k') {
      run('UPDATE bot_drafts SET kind=? WHERE id=?', b === 'problem' ? 'problem' : 'question', dr.id);
      const bs = all('SELECT b.id, b.code, u.name uni, b.year FROM batches b JOIN universities u ON u.id=b.university_id WHERE b.active=1 ORDER BY u.code, b.code');
      const rows = []; for (let i = 0; i < bs.length; i += 2) rows.push(bs.slice(i, i + 2).map(x => ({ text: `${x.code} · ${x.uni.replace('جامعة ', '')} ${x.year.replace('سنة ', '')}`.slice(0, 40), callback_data: `tb:${dr.id}:${x.id}` })));
      await ans(q); return editMsg(q, 'أنهي دفعة؟').then(() => send(chat, 'اختار الدفعة:', { reply_markup: { inline_keyboard: rows } }));
    }
    if (k === 'tb') {
      run('UPDATE bot_drafts SET batch_id=? WHERE id=?', Number(b), dr.id); await ans(q);
      if (dr.kind === 'problem') return askStudent(q, chat, dr.id, null);
      const ls = all('SELECT id, name FROM lectures WHERE batch_id=? ORDER BY sent_at DESC LIMIT 10', Number(b));
      return editMsg(q, 'على أنهي محاضرة؟').then(() => send(chat, 'اختار المحاضرة:', { reply_markup: { inline_keyboard: [...ls.map(l => [{ text: `#${l.id} ${l.name}`.slice(0, 60), callback_data: `tl:${dr.id}:${l.id}` }]), [{ text: '👨‍⚕️ سؤال لدكتور (من غير محاضرة)', callback_data: `tg:${dr.id}` }], [{ text: 'مش متأكد / من غير محاضرة', callback_data: `tl:${dr.id}:0` }]] } }));
    }
    await ans(q);
    if (k === 'tg' || k === 'tga') {
      let ds = k === 'tg' ? all("SELECT DISTINCT u.id, u.name FROM lectures l JOIN users u ON u.id=l.doctor_id WHERE l.batch_id=? AND u.active=1 ORDER BY l.sent_at DESC LIMIT 15", dr.batch_id) : [];
      if (!ds.length) ds = all("SELECT id, name FROM users WHERE role='doctor' AND active=1 ORDER BY name LIMIT 60");
      const rows = []; for (let i = 0; i < ds.length; i += 2) rows.push(ds.slice(i, i + 2).map(d => ({ text: d.name.slice(0, 30), callback_data: `tq:${dr.id}:${d.id}` })));
      if (k === 'tg') rows.push([{ text: 'كل الدكاترة', callback_data: `tga:${dr.id}` }]);
      return editMsg(q, 'سؤال لأنهي دكتور؟').then(() => send(chat, k === 'tg' ? 'اختار الدكتور (اللي شرحوا للدفعة دي فوق):' : 'كل الدكاترة:', { reply_markup: { inline_keyboard: rows } }));
    }
    if (k === 'tq') { run('UPDATE bot_drafts SET doctor_id=? WHERE id=?', Number(b), dr.id); return askStudent(q, chat, dr.id, null); }
    if (k === 'tl') { const l = one('SELECT l.id, u.name FROM lectures l JOIN users u ON u.id=l.doctor_id WHERE l.id=?', Number(b));
      if (dr.kind === 'problem' || !l) return askStudent(q, chat, dr.id, Number(b) || null);
      run('UPDATE bot_drafts SET lecture_id=? WHERE id=?', l.id, dr.id);
      return editMsg(q, 'تمام.').then(() => send(chat, 'السؤال يروح لمين؟', { reply_markup: { inline_keyboard: [[{ text: `👨‍⚕️ ${l.name} على طول`, callback_data: `tto:${dr.id}:d` }], [{ text: 'مسؤول الدفعة (يرد أو يبعته)', callback_data: `tto:${dr.id}:c` }]] } })); }
    if (k === 'tto') { run('UPDATE bot_drafts SET route=? WHERE id=?', b === 'c' ? 'coord' : 'doctor', dr.id); return askStudent(q, chat, dr.id, dr.lecture_id); }
    if (k === 'ts') { run('UPDATE bot_drafts SET await_student=0 WHERE id=?', dr.id); return askPriority(q, chat, dr.id); }
    if (k === 'tpr') { run('UPDATE bot_drafts SET priority=? WHERE id=?', Math.max(0, Math.min(3, Number(b) || 0)), dr.id); return askDue(q, chat, dr.id); }
    if (k === 'tdl') return createFromDraft(q, chat, user, { ...one('SELECT * FROM bot_drafts WHERE id=?', dr.id), due_hours: Number(b) || 0 });
  }
  const t = one('SELECT * FROM tickets WHERE id=?', Number(a)); if (!t) return ans(q, 'التذكرة مش موجودة');
  if (k === 'tsr') {
    const t0 = one('SELECT * FROM tickets WHERE id=?', Number(a)); if (!t0) return ans(q, 'مش موجود');
    const ok0 = user.role === 'admin' || one('SELECT 1 FROM batches WHERE id=? AND (coordinator_id=? OR supervisor_id=?)', t0.batch_id, user.id, user.id);
    if (!ok0) return ans(q, 'مش مسموح'); if (t0.reply_at) return ans(q, 'السؤال ده اترد عليه');
    await ans(q); const m0 = await send(chat, `اكتب ردك على السؤال #${t0.id} أو سجّله ريكورد (اعمل Reply على الرسالة دي):`, { reply_markup: { force_reply: true } });
    if (m0) run('UPDATE tickets SET cr_msg_id=? WHERE id=?', m0.message_id, t0.id); return;
  }
  const coordOk = user.role === 'admin' || (user.role === 'coordinator' && one('SELECT 1 FROM batches WHERE id=? AND coordinator_id=?', t.batch_id, user.id)) || (user.role === 'supervisor' && one('SELECT 1 FROM batches WHERE id=? AND supervisor_id=?', t.batch_id, user.id));
  if (k === 'td') {
    if (!coordOk) return ans(q, 'مش مسموح'); if (t.sent_doctor_at) return ans(q, 'اتبعت قبل كده');
    const d = one("SELECT id, name, tg_id FROM users WHERE id=? AND role='doctor'", Number(b)); if (!d) return ans(q, 'الدكتور مش موجود');
    if (!d.tg_id) return ans(q, `${d.name} مش رابط حسابه بالبوت`);
    run('UPDATE tickets SET doctor_id=?, sent_doctor_at=?, sent_by=? WHERE id=?', d.id, n, user.id, t.id);
    await sendTicket(one('SELECT * FROM tickets WHERE id=?', t.id)); audit(user.id, 'ticket_send_doctor', { id: t.id });
    await ans(q, 'اتبعت ✓'); return editMsg(q, `السؤال #${t.id} اتبعت لـ ${d.name} ✓\nهوصلك رده هنا أول ما يرد.`);
  }
  if (k === 'tr') {
    if (!coordOk) return ans(q, 'مش مسموح'); if (!t.reply_at) return ans(q, 'الدكتور لسه مارد'); if (t.returned_at) return ans(q, 'اترجع قبل كده');
    run('UPDATE tickets SET returned_at=?, returned_by=? WHERE id=?', n, user.id, t.id); audit(user.id, 'ticket_return', { id: t.id });
    await notifyCsReturn(one('SELECT * FROM tickets WHERE id=?', t.id));
    await ans(q, 'اترجع ✓'); return editMsg(q, `الرد على #${t.id} اترجع لخدمة العملاء ✓`);
  }
  if (k === 'tc') {
    if (!['cs', 'admin'].includes(user.role)) return ans(q, 'مش مسموح'); if (t.closed_at) return ans(q, 'اتقفلت قبل كده');
    run('UPDATE tickets SET delivered_at=?, delivered_by=?, closed_at=? WHERE id=?', n, user.id, n, t.id); audit(user.id, 'ticket_deliver', { id: t.id });
    await ans(q, 'اتقفلت ✓'); return editMsg(q, `السؤال #${t.id} اتقفل ✓`);
  }
  if (k === 'tp') {
    if (!(coordOk || user.role === 'cs')) return ans(q, 'مش مسموح'); if (t.closed_at) return ans(q, 'اتقفلت قبل كده');
    run('UPDATE tickets SET resolution=?, closed_at=?, closed_by=? WHERE id=?', `اتحلت (${user.name} من البوت)`, n, user.id, t.id); audit(user.id, 'ticket_bot_close', { id: t.id });
    await ans(q, 'اتقفلت ✓'); return editMsg(q, `المشكلة #${t.id} اتقفلت ✓`);
  }
  return ans(q);
}
async function askPriority(q, chat, draftId) {
  run("UPDATE bot_drafts SET stage='priority', created_at=? WHERE id=?", Date.now(), draftId);
  const kb = { inline_keyboard: [[{ text: '🔴 مهم جداً', callback_data: `tpr:${draftId}:3` }, { text: 'مهم', callback_data: `tpr:${draftId}:2` }], [{ text: 'عادي', callback_data: `tpr:${draftId}:1` }, { text: 'غير مهم', callback_data: `tpr:${draftId}:0` }]] };
  if (q) await editMsg(q, 'تمام.'); return send(chat, 'الأولوية؟ (مثلاً لو الطالب عنده امتحان قريب اختار مهم جداً)', { reply_markup: kb });
}
async function askDue(q, chat, draftId) {
  run("UPDATE bot_drafts SET stage='due', created_at=? WHERE id=?", Date.now(), draftId);
  const o = [1, 3, 6, 12, 24, 48].map(h => ({ text: `${h} ساعة`, callback_data: `tdl:${draftId}:${h}` }));
  return editMsg(q, 'تمام.').then(() => send(chat, 'عايزة الرد يرجعلك خلال قد إيه؟', { reply_markup: { inline_keyboard: [o.slice(0, 3), o.slice(3), [{ text: 'من غير مهلة', callback_data: `tdl:${draftId}:0` }]] } }));
}
async function askStudent(q, chat, draftId, lectureId) {
  run('UPDATE bot_drafts SET lecture_id=?, await_student=1, created_at=? WHERE id=?', lectureId, Date.now(), draftId);
  return editMsg(q, 'تمام.').then(() => send(chat, 'اسم الطالب أو رقمه؟ اكتبه هنا، أو دوس تخطي.', { reply_markup: { inline_keyboard: [[{ text: 'تخطي', callback_data: `ts:${draftId}` }]] } }));
}
async function createFromDraft(q, chat, user, dr) {
  const lectureId = dr.lecture_id, n = Date.now();
  const lec = lectureId ? one('SELECT id, doctor_id FROM lectures WHERE id=? AND batch_id=?', lectureId, dr.batch_id) : null;
  const gdoc = (dr.kind || 'question') !== 'question' ? null : !lec && dr.doctor_id ? one("SELECT id, name, tg_id FROM users WHERE id=? AND role='doctor'", dr.doctor_id)
    : lec && dr.route !== 'coord' ? one('SELECT id, name, tg_id FROM users WHERE id=?', lec.doctor_id) : null;
  const body = dr.body || (dr.file_kind === 'voice' || dr.file_kind === 'audio' ? '[سؤال صوتي]' : '[سؤال مرفق]');
  const r = run('INSERT INTO tickets(kind,batch_id,lecture_id,doctor_id,body,student,created_by,created_at,att_file_id,att_kind,att_mime,att_name,priority,due_at,direct,sent_doctor_at,sent_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    dr.kind || 'question', dr.batch_id, lec ? lec.id : null, lec ? lec.doctor_id : gdoc ? gdoc.id : null, body, dr.student ? String(dr.student).slice(0, 120) : null, user.id, n, dr.file_id, dr.file_kind, dr.file_kind ? KIND_MIME[dr.file_kind] : null, dr.file_kind ? `${dr.file_kind}` : null,
    dr.priority ?? 1, dr.due_hours ? n + dr.due_hours * L.H : null, gdoc ? 1 : 0, gdoc ? n : null, gdoc ? user.id : null);
  run('DELETE FROM bot_drafts WHERE id=?', dr.id);
  for (const p of JSON.parse(dr.extra || '[]')) run('INSERT INTO ticket_parts(ticket_id,body,file_id,file_kind,by,created_at) VALUES(?,?,?,?,?,?)', Number(r.lastInsertRowid), p.body, p.file_id, p.file_kind, user.id, n);
  const t = one('SELECT * FROM tickets WHERE id=?', Number(r.lastInsertRowid));
  audit(user.id, 'ticket_bot_new', { id: t.id });
  const done = async msg => { msg += '\n\n↩️ لو الطالب بعت حاجة زيادة على نفس السؤال، اعمل Reply على الرسالة دي وابعتها.'; const x = q ? await editMsg(q, msg) : await send(chat, msg); const mid = q && q.message ? q.message.message_id : x && x.message_id; if (mid) run('UPDATE tickets SET cs_msg_id=? WHERE id=?', mid, t.id); return x; };
  if (gdoc) {
    const ok = await sendTicket(t); await notifyCoordDirect(t);
    const msg = `السؤال اتسجل #${t.id} ✓\nواتبعت مباشرة لـ ${gdoc.name}${ok ? '' : ' (مش رابط البوت، هيشوفه في لوحته)'}، ومسؤول الدفعة بيتابعه.\nالرد هيوصلك هنا على طول.`;
    return done(msg);
  }
  await notifyCoordNew(t);
  const c = one('SELECT u.name, u.tg_id FROM batches b LEFT JOIN users u ON u.id=b.coordinator_id WHERE b.id=?', t.batch_id) || {};
  const msg = `${t.kind === 'problem' ? 'المشكلة' : 'السؤال'} اتسجل #${t.id} ✓\nووصل لـ ${c.name || 'مسؤول الدفعة'}${c.tg_id ? '' : ' (مش رابط البوت، هيشوفه من اللوحة)'}.${t.kind === 'question' ? '\nهبعتلك الرد هنا أول ما يرجع.' : ''}`;
  return done(msg);
}
const transferKb = id => ({ inline_keyboard: [[{ text: 'استلمت ✓', callback_data: `rc:${id}` }, { text: 'فيه مشكلة', callback_data: `rx:${id}` }]] });
async function recordTransferProblem(tr, user, text, chat) {
  run('UPDATE transfer_msgs SET problem=?, problem_at=?, problem_wait=NULL WHERE id=?', String(text).slice(0, 1000), Date.now(), tr.id);
  audit(user.id, 'transfer_problem', { id: tr.id });
  await sendAdmin(`⚠️ ${user.name} عنده مشكلة في التحويل:\n${text}\n\nراجعها من الحسابات.`);
  return chat ? send(chat, 'المشكلة وصلت للإدارة ✓ وهيتواصلوا معاك.') : null;
}
async function confirmTransfer(tr, user) {
  run('UPDATE transfer_msgs SET confirmed_at=?, problem_wait=NULL WHERE id=?', Date.now(), tr.id);
  audit(user.id, 'transfer_confirm', { id: tr.id });
  await sendAdmin(`✓ ${user.name} أكد استلام التحويل.`);
}
async function onTransferCallback(q, from, chat) {
  const user = one('SELECT * FROM users WHERE tg_id=? AND active=1', from); if (!user) return ans(q);
  const [k, a] = q.data.split(':'); const tr = one('SELECT * FROM transfer_msgs WHERE id=? AND user_id=?', Number(a), user.id);
  if (!tr) return ans(q, 'مش موجود');
  if (tr.confirmed_at) return ans(q, 'اتأكد قبل كده');
  if (k === 'rc') { await confirmTransfer(tr, user); await ans(q, 'تمام ✓'); return editMsg(q, 'اتسجل إنك استلمت التحويل ✓ شكراً.'); }
  await ans(q);
  const m = await send(chat, 'اكتب المشكلة في التحويل (اعمل Reply على الرسالة دي):', { reply_markup: { force_reply: true } });
  run('UPDATE transfer_msgs SET problem_msg_id=?, problem_wait=? WHERE id=?', m ? m.message_id : null, Date.now(), tr.id);
}
async function getFileUrl(fileId) { const f = await call('getFile', { file_id: fileId }); return f ? `${(process.env.TG_API || 'https://api.telegram.org')}/file/bot${process.env.BOT_TOKEN}/${f.file_path}` : null; }
async function forwardFile(chat_id, fileId, kind, caption) { return call(kind === 'video' ? 'sendVideo' : 'sendDocument', { chat_id, [kind === 'video' ? 'video' : 'document']: fileId, caption }); }

/* ================= v1.8: chats, /new, /menu ================= */
const RN = { admin: 'الإدارة', supervisor: 'مشرف', coordinator: 'مسؤول دفعة', cs: 'خدمة العملاء', doctor: 'دكتور' };
const kb = rows => ({ reply_markup: { inline_keyboard: rows } });
const pairs = btns => { const r = []; for (let i = 0; i < btns.length; i += 2) r.push(btns.slice(i, i + 2)); return r; };
const setFlow = (tg, kind, step, data, prompt) => run('INSERT INTO bot_flows(tg_id,kind,step,data,prompt_id,at) VALUES(?,?,?,?,?,?) ON CONFLICT(tg_id) DO UPDATE SET kind=excluded.kind, step=excluded.step, data=excluded.data, prompt_id=excluded.prompt_id, at=excluded.at', String(tg), kind, step, JSON.stringify(data || {}), prompt || null, Date.now());
const endFlow = tg => run('DELETE FROM bot_flows WHERE tg_id=?', String(tg));
const scopeIds = u => L.batchIds(u); // null = all
const inScope = (u, bid) => { const ids = scopeIds(u); return !ids || ids.includes(Number(bid)); };

async function deliverChat(m) {
  const to = one('SELECT tg_id FROM users WHERE id=? AND active=1', m.to_id), fr = one('SELECT name, role FROM users WHERE id=?', m.from_id) || {};
  if (!to || !to.tg_id) return false;
  const cap = `💬 رسالة من ${fr.name} (${RN[fr.role] || ''}):${m.body ? '\n' + m.body : ''}\n\n↩️ اعمل Reply على الرسالة دي عشان ترد.`;
  let r = null;
  if (m.file_id && m.file_kind !== 'video_note') r = await sendByKind(to.tg_id, m.file_kind, m.file_id, cap.slice(0, 1000));
  else if (m.path && require('node:fs').existsSync(m.path)) { const mime = m.mime || '', [mt, f] = mime.startsWith('image/') ? ['sendPhoto', 'photo'] : /ogg|opus/.test(mime) && !/webm/.test(mime) ? ['sendVoice', 'voice'] : ['sendDocument', 'document']; r = await sendFile(mt, f, to.tg_id, require('node:fs').readFileSync(m.path), m.name || 'file', cap.slice(0, 1000), mime); }
  else { if (m.file_id) await sendByKind(to.tg_id, m.file_kind, m.file_id, ''); r = await send(to.tg_id, cap); }
  if (r && r.message_id) run('UPDATE messages SET tg_msg_id=? WHERE id=?', r.message_id, m.id);
  return !!r;
}
async function chatPicker(chat, user) {
  const cs = require('./actions').chatContacts(user).slice(0, 40);
  if (!cs.length) return send(chat, 'مفيش حد تقدر تبعتله رسالة دلوقتي.');
  return send(chat, 'تبعت رسالة لمين؟', kb(pairs(cs.map(c => ({ text: `${c.name} · ${RN[c.role]}`.slice(0, 40), callback_data: `cm:${c.id}` })))));
}
function menuRows(u) {
  const b = (text, a) => ({ text, callback_data: `mn:${a}` });
  if (u.role === 'doctor') return [[b('📋 مهامي', 'tasks'), b('❓ أسئلتي', 'myq')], [b('💰 حسابي', 'money'), b('⭐ تقييمي', 'rate')], [b('💬 ابعت رسالة', 'msg')]];
  if (u.role === 'cs') return [[b('➕ سؤال جديد', 'newq'), b('📨 ردود مستنية تتبعت', 'dlv')], [b('❓ الأسئلة المفتوحة', 'tk'), b('👥 تسجيل اشتراكات', 'subs')], [b('💬 ابعت رسالة', 'msg')]];
  const staff = [[b('➕ محاضرة جديدة', 'new'), b('⏰ المتأخر', 'late')], [b('✅ مستني اعتماد', 'appr'), b('⬆️ مستني رفع', 'upl')], [b('❓ الأسئلة والمشاكل', 'tk'), b('📅 امتحان', 'exam')]];
  if (u.role === 'coordinator') return [...staff, [b('📝 مهام اليوم', 'ck'), b('💬 ابعت رسالة', 'msg')]];
  if (u.role === 'supervisor') return [...staff, [b('📊 التقرير اليومي', 'rep'), b('💬 ابعت رسالة', 'msg')]];
  return [[b('📊 التقرير اليومي', 'rep'), b('⚖️ قرارات مستنية', 'pen')], [b('💰 ملخص الحسابات', 'fin'), b('💬 ابعت رسالة', 'msg')], ...staff];
}
const showMenu = (chat, u, title) => send(chat, title || 'اختار:', kb(menuRows(u)));
function tasksText(u) {
  const ls = all('SELECT * FROM lectures WHERE doctor_id=? AND (video_at IS NULL OR q_at IS NULL) ORDER BY queue_pos IS NULL, queue_pos, sent_at', u.id);
  if (!ls.length) return 'مفيش محاضرات مفتوحة دلوقتي ✓';
  return 'المحاضرات بالترتيب اللي المفروض تبدأ بيه:\n\n' + ls.map((l, i) => `${i + 1}) #${l.id} ${l.name} (${L.typeLabel(l)})${coversNames(l).length ? `\n   على: ${coversNames(l).join('، ')}` : ''}\nناقص: ${[!l.video_at && 'فيديو', !l.q_at && 'أسئلة'].filter(Boolean).join(' و')} · آخر موعد ${fmt(l.sent_at + L.deadline())}${L.isLate(null, l.sent_at, l.excused) ? ' ⚠️ متأخرة' : ''}`).join('\n\n');
}
async function newFlowStart(chat, user, tg) {
  const bs = L.batchRows(user); if (!bs.length) return send(chat, 'مفيش دفعات عندك.');
  setFlow(tg, 'new', 'batch', {});
  return send(chat, 'محاضرة جديدة ➕\nأنهي دفعة؟ (/cancel للإلغاء)', kb(pairs(bs.map(b => ({ text: `${b.code} · ${b.uni}`.slice(0, 40), callback_data: `nf:b:${b.id}` })))));
}
function coverRows(d) {
  const ls = all('SELECT id, name FROM lectures WHERE batch_id=? AND type!=? ORDER BY sent_at DESC LIMIT 24', d.batch_id, 'revision'), on = new Set(d.covers || []);
  return [...ls.map(l => [{ text: `${on.has(l.id) ? '✅' : '◻️'} ${l.name}`.slice(0, 60), callback_data: `nf:c:${l.id}` }]), [{ text: `خلاص (${on.size})`, callback_data: 'nf:cd:0' }]];
}
async function askLecName(chat, tg, d) { setFlow(tg, 'new', 'name', d); return send(chat, d.type === 'revision' ? 'اكتب اسم المراجعة (زي: Cardio Revision):' : 'اكتب اسم المحاضرة:'); }
async function askLecFile(chat, tg, d) { setFlow(tg, 'new', 'file', d); return send(chat, 'لو عندك ملف المحاضرة PDF للدكتور ابعته دلوقتي، أو دوس تخطي.', kb([[{ text: 'تخطي', callback_data: 'nf:f:0' }]])); }
async function confirmLec(chat, tg, d) {
  setFlow(tg, 'new', 'confirm', d);
  const b = one('SELECT code FROM batches WHERE id=?', d.batch_id) || {}, doc = one('SELECT u.name, x.* FROM users u JOIN doctors x ON x.user_id=u.id WHERE u.id=?', d.doctor_id) || {};
  const price = d.price ?? doc[`price_${d.type}`], cv = (d.covers || []).length ? all(`SELECT name FROM lectures WHERE id IN (${d.covers.map(Number).join(',')})`).map(x => x.name) : [];
  return send(chat, `راجع قبل الإرسال:\nالدفعة: ${b.code}\nالدكتور: ${doc.name}\nالنوع: ${L.typeLabel(d)}\nالاسم: ${d.name}${cv.length ? `\nعلى المحاضرات: ${cv.join('، ')}` : ''}\nالسعر: ${money(price)}${d.lec_file_id ? '\nملف PDF: ✓' : ''}`, kb([[{ text: 'ابعت ✓', callback_data: 'nf:go:0' }, { text: 'إلغاء', callback_data: 'nf:x:0' }]]));
}
async function onFlowInput(fl, m, user, chat, tg, text, mc) {
  const d = JSON.parse(fl.data || '{}');
  if (fl.kind === 'chat') {
    if (!text && !mc) return false; const to = one('SELECT * FROM users WHERE id=? AND active=1', d.to); endFlow(tg); if (!to) return send(chat, 'الشخص ده مش موجود.');
    const r = await require('./actions').sendChat(user, to, { body: text || m.caption || '', file: mc ? { file_id: mc[1], kind: mc[0] } : null });
    return send(chat, r.delivered ? `اتبعتت لـ ${to.name} ✓` : `اتسجلت لـ ${to.name}، بس هو مش رابط البوت (هيشوفها في اللوحة).`);
  }
  if (fl.kind === 'exam' && text) {
    const mm = /^(\d{4}-\d{2}-\d{2})\s*(.*)$/.exec(text.replace(/\//g, '-')); if (!mm) return send(chat, 'اكتبها بالشكل ده: 2026-12-11 باطنة');
    run('INSERT INTO exams(batch_id,date,name,created_by,created_at) VALUES(?,?,?,?,?)', d.batch_id, mm[1], mm[2] || null, user.id, Date.now()); endFlow(tg);
    return send(chat, `اتسجل امتحان ${mm[1]}${mm[2] ? ' · ' + mm[2] : ''} ✓`);
  }
  if (fl.kind === 'subs' && text) {
    const n = Number(text.replace(/[^\d]/g, '')); if (!text.match(/\d/)) return send(chat, 'اكتب عدد المشتركين رقم.');
    run('INSERT INTO subs(batch_id,day,count,by,created_at) VALUES(?,?,?,?,?)', d.batch_id, L.dayStr(), n, user.id, Date.now()); endFlow(tg);
    return send(chat, `اتسجل ${n} مشترك ✓`);
  }
  if (fl.kind === 'new') {
    if (fl.step === 'name' && text) { d.name = text.slice(0, 200); if (d.kind === 'repeat') { setFlow(tg, 'new', 'price', d); return send(chat, 'دي معادة: اكتب سعرها بالرقم:'); } return askLecFile(chat, tg, d); }
    if (fl.step === 'price' && text) { const p = Number(text.replace(/[^\d.]/g, '')); if (!(p >= 0) || !text.match(/\d/)) return send(chat, 'اكتب السعر رقم.'); d.price = p; return askLecFile(chat, tg, d); }
    if (fl.step === 'file' && m.document) { d.lec_file_id = m.document.file_id; return confirmLec(chat, tg, d); }
  }
  return false;
}
async function onFlowCallback(q, from, chat) {
  const user = one('SELECT * FROM users WHERE tg_id=? AND active=1', from); if (!user) return ans(q);
  const [k, a, b] = q.data.split(':'); const staff = ['admin', 'coordinator', 'supervisor'].includes(user.role);
  if (k === 'cm') { const to = one('SELECT * FROM users WHERE id=? AND active=1', Number(a)); if (!to || !require('./actions').canChat(user, to)) return ans(q, 'مش مسموح'); await ans(q); setFlow(from, 'chat', 'text', { to: to.id }); return editMsg(q, `اكتب رسالتك لـ ${to.name} (نص أو ريكورد أو صورة أو ملف):`); }
  if (k === 'nf') {
    if (!staff) return ans(q, 'مش مسموح'); const fl = one("SELECT * FROM bot_flows WHERE tg_id=? AND kind='new'", from); if (!fl) return ans(q, 'انتهت، ابدأ تاني بـ /new');
    const d = JSON.parse(fl.data || '{}'); await ans(q);
    if (a === 'b') { if (!inScope(user, b)) return; d.batch_id = Number(b); setFlow(from, 'new', 'doctor', d);
      let ds = all('SELECT DISTINCT u.id, u.name FROM lectures l JOIN users u ON u.id=l.doctor_id WHERE l.batch_id=? AND u.active=1 ORDER BY l.sent_at DESC LIMIT 12', d.batch_id);
      for (const x of all("SELECT id, name FROM users WHERE role='doctor' AND active=1 ORDER BY name LIMIT 40")) if (!ds.some(y => y.id === x.id)) ds.push(x);
      return editMsg(q, 'أنهي دكتور؟ (اللي شرحوا للدفعة دي فوق)').then(() => send(chat, 'الدكتور:', kb(pairs(ds.slice(0, 40).map(x => ({ text: x.name.slice(0, 30), callback_data: `nf:d:${x.id}` })))))); }
    if (a === 'd') { d.doctor_id = Number(b); setFlow(from, 'new', 'type', d); return editMsg(q, 'النوع؟').then(() => send(chat, 'النوع:', kb([[{ text: 'نظري', callback_data: 'nf:t:theory' }, { text: 'عملي', callback_data: 'nf:t:practical' }, { text: '📚 مراجعة', callback_data: 'nf:t:revision' }]]))); }
    if (a === 't') { if (!(b in L.TYPES)) return; d.type = b;
      if (b === 'revision') { d.kind = 'new'; d.covers = []; setFlow(from, 'new', 'covers', d); return editMsg(q, 'مراجعة 📚').then(() => send(chat, 'المراجعة على أنهي محاضرات؟ علّم عليها وبعدين دوس خلاص:', kb(coverRows(d)))); }
      setFlow(from, 'new', 'kind', d); return editMsg(q, L.TYPES[b]).then(() => send(chat, 'نوع الشرح:', kb([[{ text: 'محاضرة جديدة', callback_data: 'nf:k:new' }, { text: 'استكمال شرح', callback_data: 'nf:k:continue' }, { text: 'معادة', callback_data: 'nf:k:repeat' }]]))); }
    if (a === 'k') { if (!(b in L.KINDS)) return; d.kind = b; await editMsg(q, L.KINDS[b]); return askLecName(chat, from, d); }
    if (a === 'c') { const id = Number(b), set = new Set(d.covers || []); set.has(id) ? set.delete(id) : set.add(id); d.covers = [...set]; setFlow(from, 'new', 'covers', d);
      return q.message ? call('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: coverRows(d) } }) : null; }
    if (a === 'cd') { await editMsg(q, `اخترت ${(d.covers || []).length} محاضرة ✓`); return askLecName(chat, from, d); }
    if (a === 'f') { await editMsg(q, 'من غير ملف.'); return confirmLec(chat, from, d); }
    if (a === 'x') { endFlow(from); return editMsg(q, 'اتلغت.'); }
    if (a === 'go') {
      endFlow(from);
      try {
        const r = await require('./actions').createLecture(user, d, {});
        if (d.lec_file_id) { const doc = one('SELECT tg_id FROM users WHERE id=?', d.doctor_id); if (doc && doc.tg_id) await sendByKind(doc.tg_id, 'document', d.lec_file_id, `ملف المحاضرة #${r.id}`); run('UPDATE lectures SET lec_file=? WHERE id=?', d.lec_file_id, r.id); }
        return editMsg(q, `اتبعتت لـ ${r.doctor} ✓ #${r.id}${r.delivered_to_bot ? '' : ' (الدكتور مش رابط البوت، هيشوفها في اللوحة)'}${r.over_capacity ? `\n⚠️ الدكتور عدّى طاقته النهارده (${r.today}/${r.capacity})` : ''}`);
      } catch (e) { return send(chat, `ماتبعتتش: ${e.message}`); }
    }
    return;
  }
  if (k === 'ap' || k === 'upl') {
    if (!staff) return ans(q, 'مش مسموح'); const l = one('SELECT * FROM lectures WHERE id=?', Number(k === 'ap' && a === 'f' ? b : a)); if (!l || !inScope(user, l.batch_id)) return ans(q, 'مش موجودة');
    const n = Date.now();
    if (k === 'ap' && a === 'f') { await ans(q); if (l.video_file) await forwardFile(chat, l.video_file, 'video', `#${l.id} ${l.name} · فيديو`); if (l.q_file) await forwardFile(chat, l.q_file, 'doc', `#${l.id} ${l.name} · ملف الأسئلة`); return; }
    if (k === 'ap') { if (l.video_at && !l.video_ok_at) run('UPDATE lectures SET video_ok_at=?, ok_by=? WHERE id=?', n, user.id, l.id); if (l.q_at && !l.q_ok_at) run('UPDATE lectures SET q_ok_at=?, ok_by=? WHERE id=?', n, user.id, l.id); audit(user.id, 'bot_approve', { lecture: l.id }); await ans(q, 'اتعتمد ✓'); return editMsg(q, `اتعتمد ✓ #${l.id} ${l.name}\nارفعه على Nerdio والقناة، وبعدين من /menu ← مستني رفع.`); }
    if (!l.video_ok_at || !l.q_ok_at) return ans(q, 'لسه مااتعتمدش');
    run('UPDATE lectures SET uploaded_at=COALESCE(uploaded_at,?), uploaded_by=COALESCE(uploaded_by,?) WHERE id=?', n, user.id, l.id); audit(user.id, 'bot_uploaded', { lecture: l.id }); await ans(q, 'تم ✓'); return editMsg(q, `اترفعت ✓ #${l.id} ${l.name}`);
  }
  if (k === 'ck') {
    if (user.role !== 'coordinator') return ans(q, 'مش مسموح'); const weekly = a in L.WEEKLY; if (!(a in L.DAILY) && !weekly) return ans(q);
    const per = weekly ? L.weekStr() : L.dayStr(), cur = one('SELECT done FROM checklist WHERE user_id=? AND period=? AND item=?', user.id, per, a), dn = !(cur && cur.done);
    run('INSERT INTO checklist(user_id,period,item,done,note,done_at) VALUES(?,?,?,?,NULL,?) ON CONFLICT(user_id,period,item) DO UPDATE SET done=excluded.done, done_at=excluded.done_at', user.id, per, a, dn ? 1 : 0, dn ? Date.now() : null);
    await ans(q, dn ? '✓' : 'اتشال'); return q.message ? call('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: checklistRows(user) } }) : null;
  }
  if (k === 'ex' || k === 'sb') {
    if (k === 'ex' && !staff) return ans(q, 'مش مسموح'); if (k === 'sb' && !['cs', 'admin'].includes(user.role)) return ans(q, 'مش مسموح');
    if (!inScope(user, a)) return ans(q); await ans(q); const bt = one('SELECT code FROM batches WHERE id=?', Number(a)) || {};
    setFlow(from, k === 'ex' ? 'exam' : 'subs', 'text', { batch_id: Number(a) });
    return editMsg(q, k === 'ex' ? `امتحان دفعة ${bt.code}\nاكتب التاريخ واسم الامتحان، زي: 2026-12-11 باطنة` : `اشتراكات دفعة ${bt.code}\nاكتب عدد المشتركين:`);
  }
  if (k === 'pa') {
    if (user.role !== 'admin') return ans(q, 'مش مسموح'); const pen = one("SELECT * FROM penalties WHERE id=? AND status='proposed'", Number(a)); if (!pen) return ans(q, 'اتقرر قبل كده');
    if (b === 'ok') { run("UPDATE penalties SET status='approved', decided_by=?, decided_at=? WHERE id=?", user.id, Date.now(), pen.id); await notifyPenalty(one('SELECT * FROM penalties WHERE id=?', pen.id)); }
    else run("UPDATE penalties SET status='rejected', decided_by=?, decided_at=? WHERE id=?", user.id, Date.now(), pen.id);
    audit(user.id, b === 'ok' ? 'bot_penalty_ok' : 'bot_penalty_no', { id: pen.id }); await ans(q, 'تم'); return editMsg(q, b === 'ok' ? 'اتعتمد ✓' : 'اترفض ✓');
  }
  if (k === 'mn') { await ans(q); return menuAction(a, user, chat, from); }
  return ans(q);
}
function checklistRows(u) {
  const done = new Set(all('SELECT item FROM checklist WHERE user_id=? AND done=1 AND period IN (?,?)', u.id, L.dayStr(), L.weekStr()).map(r => r.item));
  return [...Object.entries(L.DAILY).map(([k, v]) => [{ text: `${done.has(k) ? '✅' : '◻️'} ${v}`.slice(0, 60), callback_data: `ck:${k}` }]), ...Object.entries(L.WEEKLY).map(([k, v]) => [{ text: `${done.has(k) ? '✅' : '◻️'} ${v} (أسبوعي)`.slice(0, 60), callback_data: `ck:${k}` }])];
}
async function menuAction(a, user, chat, tg) {
  const ids = scopeIds(user), bw = ids ? `batch_id IN (${ids.length ? ids.join(',') : 0})` : '1=1', staff = ['admin', 'coordinator', 'supervisor'].includes(user.role);
  const bcode = id => (one('SELECT code FROM batches WHERE id=?', id) || {}).code || '';
  switch (a) {
    case 'msg': return chatPicker(chat, user);
    case 'tasks': return send(chat, tasksText(user));
    case 'myq': { const ts = all('SELECT * FROM tickets WHERE doctor_id=? AND sent_doctor_at IS NOT NULL AND reply_at IS NULL ORDER BY priority DESC, sent_doctor_at', user.id);
      if (!ts.length) return send(chat, 'مفيش أسئلة مستنية ردك ✓');
      return send(chat, `أسئلة مستنية ردك (${ts.length}):\n\n${ts.map(t => `#${t.id}${t.priority >= 2 ? ' 🔴 مستعجل' : ''}${t.due_at ? ` · قبل ${fmt(t.due_at)}` : ''}\n${t.body.slice(0, 200)}`).join('\n\n')}\n\nاعمل Reply على رسالة السؤال الأصلية، أو رد من صفحة "الأسئلة" في اللوحة.`); }
    case 'money': { const p = L.payable(user.id); return send(chat, `حسابك لحد دلوقتي (مااتقفلش):\nمحاضرات اتسلمت: ${p.lecs ? p.lecs.length : 0}\nالإجمالي: ${money(p.gross)}${p.bonus ? `\nبونص: ${money(p.bonus)}` : ''}${p.deductions ? `\nخصومات: ${money(p.deductions)}` : ''}\nالصافي: ${money(p.net)}\n\nكشوف الحساب PDF في اللوحة ← حسابي.`); }
    case 'rate': { const s = L.doctorStats(user.id), sc = s.score || {}, r1 = x => (x == null ? '—' : Math.round(x)); return send(chat, `تقييمك آخر 30 يوم: ${sc.total ?? '—'} / 100\nالالتزام بالمهلة: ${r1(sc.dl)}/35\nالفيديو: ${r1(sc.video)}/40 · الأسئلة: ${r1(sc.q)}/10\nالتعليمات: ${r1(sc.instr)}/10 · التواصل: ${r1(sc.comm)}/5\nمتأخر دلوقتي: ${s.lateNow}`); }
    case 'new': return staff ? newFlowStart(chat, user, tg) : null;
    case 'late': { const ls = all(`SELECT l.*, u.name dn FROM lectures l JOIN users u ON u.id=l.doctor_id WHERE ${bw.replace('batch_id', 'l.batch_id')} AND (l.video_at IS NULL OR l.q_at IS NULL) AND l.excused=0 AND l.sent_at<? ORDER BY l.sent_at LIMIT 20`, Date.now() - L.deadline());
      return send(chat, ls.length ? `⏰ متأخر (${ls.length}):\n\n${ls.map(l => `#${l.id} ${l.name} · دفعة ${bcode(l.batch_id)}\n${l.dn} · متأخرة من ${L.fmtDur(Date.now() - l.sent_at - L.deadline())}`).join('\n\n')}` : 'مفيش متأخر ✓'); }
    case 'appr': { const ls = all(`SELECT * FROM lectures WHERE ${bw} AND ((video_at IS NOT NULL AND video_ok_at IS NULL) OR (q_at IS NOT NULL AND q_ok_at IS NULL)) ORDER BY priority DESC, sent_at LIMIT 10`);
      if (!ls.length) return send(chat, 'مفيش حاجة مستنية اعتماد ✓');
      for (const l of ls) await send(chat, `#${l.id} ${l.name} · دفعة ${bcode(l.batch_id)}\nالفيديو: ${l.video_at ? (l.video_ok_at ? 'اتعتمد ✓' : 'وصل') : 'لسه'} · الأسئلة: ${l.no_q ? 'معفي' : l.q_at ? (l.q_ok_at ? 'اتعتمد ✓' : 'وصل') : 'لسه'}`, kb([[{ text: '📥 ابعتلي الملفات', callback_data: `ap:f:${l.id}` }, { text: 'اعتمد اللي وصل ✓', callback_data: `ap:${l.id}` }]]));
      return; }
    case 'upl': { const ls = all(`SELECT * FROM lectures WHERE ${bw} AND video_ok_at IS NOT NULL AND q_ok_at IS NOT NULL AND uploaded_at IS NULL ORDER BY priority DESC, sent_at LIMIT 10`);
      if (!ls.length) return send(chat, 'مفيش حاجة مستنية رفع ✓');
      for (const l of ls) await send(chat, `#${l.id} ${l.name} · دفعة ${bcode(l.batch_id)}\nاتعتمدت من ${L.fmtDur(Date.now() - Math.max(l.video_ok_at, l.q_ok_at))}`, kb([[{ text: '📥 الملفات', callback_data: `ap:f:${l.id}` }, { text: 'تم الرفع ✓', callback_data: `upl:${l.id}` }]]));
      return; }
    case 'tk': { const ts = all(`SELECT t.*, u.name dn FROM tickets t LEFT JOIN users u ON u.id=t.doctor_id WHERE ${bw.replace('batch_id', 't.batch_id')} AND t.closed_at IS NULL ORDER BY t.priority DESC, t.created_at LIMIT 15`);
      if (!ts.length) return send(chat, 'مفيش أسئلة أو مشاكل مفتوحة ✓');
      const st = t => (t.kind === 'problem' ? 'مشكلة مفتوحة' : !t.sent_doctor_at ? 'عند مسؤول الدفعة' : !t.reply_at ? `مستني رد ${t.dn || 'الدكتور'} من ${L.fmtDur(Date.now() - t.sent_doctor_at)}` : !t.returned_at ? 'الرد مستني يرجع' : 'مستني يتبعت للطالب');
      return send(chat, `المفتوح (${ts.length}):\n\n${ts.map(t => `#${t.id}${t.priority >= 2 ? ' 🔴' : ''} · دفعة ${bcode(t.batch_id)} · ${st(t)}${t.due_at && Date.now() > t.due_at ? ' ⚠️ عدّى المهلة' : ''}\n${t.body.slice(0, 120)}`).join('\n\n')}`); }
    case 'exam': { if (!staff) return; const bs = L.batchRows(user); return send(chat, 'امتحان لأنهي دفعة؟', kb(pairs(bs.map(b => ({ text: `${b.code}${b.exam_date ? ` (أقرب: ${b.exam_date})` : ''}`.slice(0, 40), callback_data: `ex:${b.id}` }))))); }
    case 'ck': return send(chat, `مهام النهارده — دوس على المهمة عشان تعلّم عليها:`, kb(checklistRows(user)));
    case 'rep': return send(chat, L.dailyReportText(L.dailyReport(user)));
    case 'newq': return send(chat, 'ابعت سؤال الطالب هنا على طول (نص أو ريكورد أو صورة)، وأنا هسألك عن الدفعة والمحاضرة والباقي.');
    case 'dlv': { const ts = all('SELECT * FROM tickets WHERE returned_at IS NOT NULL AND delivered_at IS NULL AND closed_at IS NULL ORDER BY priority DESC, returned_at LIMIT 10');
      if (!ts.length) return send(chat, 'مفيش ردود مستنية تتبعت ✓');
      for (const t of ts) await notifyCsReturn(t); return; }
    case 'subs': { if (!['cs', 'admin'].includes(user.role)) return; const bs = L.batchRows(user); return send(chat, 'اشتراكات أنهي دفعة؟', kb(pairs(bs.map(b => ({ text: `${b.code}${b.subs != null ? ` (آخر: ${b.subs})` : ''}`.slice(0, 40), callback_data: `sb:${b.id}` }))))); }
    case 'pen': { const ps = all("SELECT p.*, u.name FROM penalties p JOIN users u ON u.id=p.user_id WHERE p.status='proposed' ORDER BY p.created_at LIMIT 10");
      if (!ps.length) return send(chat, 'مفيش قرارات مستنية ✓');
      for (const p of ps) await send(chat, `${p.name}\n${p.kind}${p.amount ? ` · ${money(p.amount)}` : ''}\nالسبب: ${p.reason}`, kb([[{ text: 'اعتماد ✓', callback_data: `pa:${p.id}:ok` }, { text: 'رفض', callback_data: `pa:${p.id}:no` }]]));
      return; }
    case 'fin': { const rows = all("SELECT id, role FROM users WHERE active=1 AND role!='admin'"), tot = {}; for (const r of rows) { const p = L.payable(r.id); tot[r.role] = (tot[r.role] || 0) + p.net; }
      const sum = Object.values(tot).reduce((s, x) => s + x, 0);
      return send(chat, `المستحق دلوقتي (مااتقفلش):\n${Object.entries(tot).map(([r, v]) => `${RN[r]}: ${money(v)}`).join('\n')}\nالإجمالي: ${money(sum)}\n\nالتفاصيل والتقفيل من اللوحة ← الحسابات.`); }
  }
  return null;
}

module.exports = { addPart, deliverChat, afterDoctorReply, showMenu, menuAction, notifyCoordDirect, prioLine, lateAlert, transferKb, confirmTransfer, recordTransferProblem, notifyCoordNew, notifyCsReturn, notifyCoordReply, KIND_MIME, call, send, sendFile, sendLecture, sendTicket, notifyPenalty, notifyPriceChange, remind, sendAdmin, handleUpdate: handleUpdateQueued, enabled, fmt, money, forwardFile, getFileUrl };
