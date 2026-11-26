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

function lectureText(l, title = 'محاضرة جديدة') {
  return `${title} #${l.id}\n${l.name}\nالنوع: ${L.typeLabel(l)}\nالسعر: ${money(l.price)}\n${l.no_q ? 'المطلوب: فيديو الشرح بس (مفيش ملف أسئلة)' : 'المطلوب: فيديو الشرح + ملف الأسئلة'}\nآخر موعد: ${fmt(l.sent_at + L.deadline())}`;
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
  return true;
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
  if (t.kind === 'problem') { await send(c.tg_id, `مشكلة جديدة #${t.id}\n${tkHead(t)}\n\n${t.body}`, { reply_markup: { inline_keyboard: [[{ text: 'اتحلت ✓', callback_data: `tp:${t.id}` }]] } }); if (t.att_file_id || t.att_path) await sendAtt(c.tg_id, t, `مرفق المشكلة #${t.id}`); return; }
  const docs = [];
  if (t.lecture_id) { const d = one('SELECT u.id, u.name FROM lectures l JOIN users u ON u.id=l.doctor_id WHERE l.id=?', t.lecture_id); if (d) docs.push(d); }
  for (const d of all("SELECT DISTINCT u.id, u.name FROM lectures l JOIN users u ON u.id=l.doctor_id WHERE l.batch_id=? AND u.active=1 ORDER BY l.sent_at DESC LIMIT 12", t.batch_id)) if (!docs.some(x => x.id === d.id)) docs.push(d);
  if (!docs.length) for (const d of all("SELECT id, name FROM users WHERE role='doctor' AND active=1 ORDER BY name LIMIT 30")) docs.push(d);
  await send(c.tg_id, `سؤال جديد من خدمة العملاء #${t.id}\n${tkHead(t)}\n\n${t.body}\n\nابعته لأنهي دكتور؟`, { reply_markup: { inline_keyboard: docs.map((d, i) => [{ text: `${i === 0 && t.lecture_id ? '⭐ ' : ''}${d.name}`, callback_data: `td:${t.id}:${d.id}` }]) } });
  if (t.att_file_id || t.att_path) await sendAtt(c.tg_id, t, `السؤال #${t.id}`);
}
async function notifyCoordDirect(t) {
  const c = one('SELECT u.tg_id FROM batches b JOIN users u ON u.id=b.coordinator_id WHERE b.id=?', t.batch_id), d = one('SELECT name FROM users WHERE id=?', t.doctor_id) || {};
  if (c && c.tg_id) await send(c.tg_id, `سؤال اتبعت مباشرة لـ ${d.name} #${t.id}\n${tkHead(t)}\n\n${t.body}\n\nمش محتاج تعمل حاجة دلوقتي. أول ما الدكتور يرد هيوصلك الرد هنا عشان ترجّعه لخدمة العملاء.`);
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
async function notifyCsReturn(t) {
  const kb = { reply_markup: { inline_keyboard: [[{ text: 'اتبعت للطالب ✓', callback_data: `tc:${t.id}` }]] } };
  for (const c of all("SELECT tg_id FROM users WHERE role='cs' AND active=1 AND tg_id IS NOT NULL")) {
    await send(c.tg_id, `رد جاهز للطالب #${t.id}\n${tkHead(t)}\n\nالسؤال: ${t.body}\n\nالرد: ${t.reply}${t.reply_file_id ? '\n(الرد الصوتي/الملف تحت الرسالة دي، اعمله Forward للطالب)' : ''}\n\nمعاك ${setting('cs_reply_minutes')} دقيقة.`, t.reply_file_id ? {} : kb);
    if (t.reply_file_id) await sendByKind(c.tg_id, t.reply_kind, t.reply_file_id, `رد على السؤال #${t.id}`, kb);
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
  // problem with a transfer (after pressing "فيه مشكلة")
  const rTo = m.reply_to_message && m.reply_to_message.message_id;
  const trp = (rTo && one('SELECT * FROM transfer_msgs WHERE user_id=? AND problem_msg_id=?', user.id, rTo)) || (!rTo && text && !text.startsWith('/') && one('SELECT * FROM transfer_msgs WHERE user_id=? AND problem_wait>? AND problem IS NULL ORDER BY id DESC', user.id, Date.now() - 30 * 60e3));
  if (trp && text) return recordTransferProblem(trp, user, text, chat);
  if (user.role === 'cs' || (user.role === 'admin' && !text.startsWith('/'))) {
    const aw = one("SELECT * FROM bot_drafts WHERE tg_id=? AND (await_student=1 OR stage IN ('priority','due')) AND created_at>? ORDER BY id DESC", from, Date.now() - 6 * L.H);
    if (aw) {
      if (aw.await_student && text && !msgContent(m) && text.length <= 120) { run('UPDATE bot_drafts SET student=?, await_student=0 WHERE id=?', text, aw.id); return askPriority(null, chat, aw.id); }
      await createFromDraft(null, chat, user, aw); // a new message came instead: save the pending one with defaults
    }
  }
  if (user.role === 'cs' || (user.role === 'admin' && !text.startsWith('/'))) {
    const c = msgContent(m), body = (text || m.caption || '').trim();
    if (!c && !body) return send(chat, 'ابعت سؤال الطالب هنا (نص أو ريكورد أو صورة)، وأنا هوصّله لمسؤول الدفعة.');
    run('DELETE FROM bot_drafts WHERE tg_id=? AND batch_id IS NULL', from);
    const r = run('INSERT INTO bot_drafts(tg_id,body,file_id,file_kind,created_at) VALUES(?,?,?,?,?)', from, body || null, c ? c[1] : null, c ? c[0] : null, Date.now());
    return send(chat, 'تمام. ده سؤال لدكتور ولا مشكلة؟', { reply_markup: { inline_keyboard: [[{ text: 'سؤال لدكتور', callback_data: `k:${r.lastInsertRowid}:question` }, { text: 'مشكلة', callback_data: `k:${r.lastInsertRowid}:problem` }]] } });
  }
  if (user.role !== 'doctor') return send(chat, `أهلاً ${user.name}، حسابك مربوط بالبوت ✓\nالبوت بيستقبل الفيديوهات وملفات الأسئلة من حسابات الدكاترة بس.\nإرسال المحاضرات للدكاترة بيتم من لوحة التحكم، والبوت هيبعتلك هنا أي ملفات تطلبها من صفحة المحاضرة (زرار "ابعتلي الملفات على تليجرام").`);
  if (text === '/tasks') {
    const ls = all('SELECT * FROM lectures WHERE doctor_id=? AND (video_at IS NULL OR q_at IS NULL) ORDER BY queue_pos IS NULL, queue_pos, sent_at', user.id);
    if (ls.length) ls.forEach((l, i) => (l._n = i + 1));
    if (!ls.length) return send(chat, 'مفيش محاضرات مفتوحة دلوقتي ✓');
    return send(chat, 'المحاضرات بالترتيب اللي المفروض تبدأ بيه:\n\n' + ls.map(l => `${l._n}) #${l.id} ${l.name} (${L.typeLabel(l)})\nناقص: ${[!l.video_at && 'فيديو', !l.q_at && 'أسئلة'].filter(Boolean).join(' + ')} · ${L.isLate(null, l.sent_at, l.excused) ? 'متأخر' : 'آخر موعد ' + fmt(l.sent_at + L.deadline())}`).join('\n\n'));
  }
  // reply to a student question
  const replyTo = m.reply_to_message && m.reply_to_message.message_id;
  let ticket = replyTo ? one('SELECT * FROM tickets WHERE (tg_msg_id=? OR att_msg_id=?) AND doctor_id=? AND reply_at IS NULL', replyTo, replyTo, user.id) : null;
  const rf = m.voice ? ['voice', m.voice.file_id] : m.audio ? ['audio', m.audio.file_id] : m.video_note ? ['video_note', m.video_note.file_id] : m.photo ? ['photo', m.photo.at(-1).file_id] : (ticket && m.video) ? ['video', m.video.file_id] : (ticket && m.document) ? ['document', m.document.file_id] : null;
  if (!ticket && (text || (rf && !m.video && !m.document)) && !m.video && !m.document) {
    const waiting = all('SELECT * FROM tickets WHERE doctor_id=? AND sent_doctor_at IS NOT NULL AND reply_at IS NULL', user.id);
    if (waiting.length === 1) ticket = waiting[0];
    else if (waiting.length > 1) return send(chat, 'عندك أكتر من سؤال مستني رد. اعمل Reply على رسالة السؤال نفسها واكتب ردك.');
  }
  if (ticket && (text || rf)) {
    const label = { voice: '[رد صوتي]', audio: '[رد صوتي]', video_note: '[رد فيديو]', photo: '[رد صورة]', video: '[رد فيديو]', document: '[رد ملف]' };
    run('UPDATE tickets SET reply=?, reply_at=?, reply_file_id=?, reply_kind=? WHERE id=?', text || m.caption || label[rf[0]], Date.now(), rf ? rf[1] : null, rf ? rf[0] : null, ticket.id);
    notifyCoordReply(one('SELECT * FROM tickets WHERE id=?', ticket.id)).catch(e => console.error('notify', e));
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
  if (/^(k|tb|tl|ts|tg|tga|tq|tpr|tdl|td|tr|tc|tp):/.test(q.data || '')) return onTicketCallback(q, from, chat);
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
  if (['k', 'tb', 'tl', 'ts', 'tg', 'tga', 'tq', 'tpr', 'tdl'].includes(k)) {
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
    if (k === 'tl') return askStudent(q, chat, dr.id, Number(b) || null);
    if (k === 'ts') { run('UPDATE bot_drafts SET await_student=0 WHERE id=?', dr.id); return askPriority(q, chat, dr.id); }
    if (k === 'tpr') { run('UPDATE bot_drafts SET priority=? WHERE id=?', Math.max(0, Math.min(3, Number(b) || 0)), dr.id); return askDue(q, chat, dr.id); }
    if (k === 'tdl') return createFromDraft(q, chat, user, { ...one('SELECT * FROM bot_drafts WHERE id=?', dr.id), due_hours: Number(b) || 0 });
  }
  const t = one('SELECT * FROM tickets WHERE id=?', Number(a)); if (!t) return ans(q, 'التذكرة مش موجودة');
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
  const gdoc = !lec && dr.doctor_id && (dr.kind || 'question') === 'question' ? one("SELECT id, name, tg_id FROM users WHERE id=? AND role='doctor'", dr.doctor_id) : null;
  const body = dr.body || (dr.file_kind === 'voice' || dr.file_kind === 'audio' ? '[سؤال صوتي]' : '[سؤال مرفق]');
  const r = run('INSERT INTO tickets(kind,batch_id,lecture_id,doctor_id,body,student,created_by,created_at,att_file_id,att_kind,att_mime,att_name,priority,due_at,direct,sent_doctor_at,sent_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    dr.kind || 'question', dr.batch_id, lec ? lec.id : null, lec ? lec.doctor_id : gdoc ? gdoc.id : null, body, dr.student ? String(dr.student).slice(0, 120) : null, user.id, n, dr.file_id, dr.file_kind, dr.file_kind ? KIND_MIME[dr.file_kind] : null, dr.file_kind ? `${dr.file_kind}` : null,
    dr.priority ?? 1, dr.due_hours ? n + dr.due_hours * L.H : null, gdoc ? 1 : 0, gdoc ? n : null, gdoc ? user.id : null);
  run('DELETE FROM bot_drafts WHERE id=?', dr.id);
  const t = one('SELECT * FROM tickets WHERE id=?', Number(r.lastInsertRowid));
  audit(user.id, 'ticket_bot_new', { id: t.id });
  if (gdoc) {
    const ok = await sendTicket(t); await notifyCoordDirect(t);
    const msg = `السؤال اتسجل #${t.id} ✓\nواتبعت مباشرة لـ ${gdoc.name}${ok ? '' : ' (مش رابط البوت، هيشوفه في لوحته)'}.\nهبعتلك الرد هنا أول ما يرجع.`;
    return q ? editMsg(q, msg) : send(chat, msg);
  }
  await notifyCoordNew(t);
  const c = one('SELECT u.name, u.tg_id FROM batches b LEFT JOIN users u ON u.id=b.coordinator_id WHERE b.id=?', t.batch_id) || {};
  const msg = `${t.kind === 'problem' ? 'المشكلة' : 'السؤال'} اتسجل #${t.id} ✓\nووصل لـ ${c.name || 'مسؤول الدفعة'}${c.tg_id ? '' : ' (مش رابط البوت، هيشوفه من اللوحة)'}.${t.kind === 'question' ? '\nهبعتلك الرد هنا أول ما يرجع.' : ''}`;
  return q ? editMsg(q, msg) : send(chat, msg);
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

module.exports = { notifyCoordDirect, prioLine, lateAlert, transferKb, confirmTransfer, recordTransferProblem, notifyCoordNew, notifyCsReturn, notifyCoordReply, KIND_MIME, call, send, sendFile, sendLecture, sendTicket, notifyPenalty, notifyPriceChange, remind, sendAdmin, handleUpdate, enabled, fmt, money, forwardFile, getFileUrl };
