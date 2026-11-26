'use strict';
// تجربة كاملة للنظام: سيرفر تليجرام وهمي + كل الأدوار.  npm test
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

const DATA = fs.mkdtempSync('/tmp/vmx-');
const PORT = 3911, TGP = 3912, SECRET = 'testsecret';
const tgCalls = [];
let msgId = 1000;
const tg = http.createServer((req, res) => {
  const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
    if (req.url.startsWith('/file/')) { res.setHeader('content-type', 'audio/ogg'); return res.end('OGGDATA'); }
    const method = req.url.split('/').pop(); const raw = Buffer.concat(chunks);
    let body = {}; try { body = JSON.parse(raw.toString()); } catch { body = { multipart: true, size: raw.length, text: raw.toString('latin1').slice(0, 3000) }; }
    tgCalls.push({ method, body });
    let result = true;
    if (['sendMessage', 'sendDocument', 'sendVideo', 'sendVoice', 'sendAudio', 'sendPhoto'].includes(method)) result = { message_id: ++msgId, document: { file_id: 'FILE' + msgId } };
    if (method === 'getFile') result = { file_path: 'voice/file.ogg' };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result }));
  });
});

const env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), TG_API: `http://127.0.0.1:${TGP}`, BOT_TOKEN: 'TEST', WEBHOOK_SECRET: SECRET, SESSION_SECRET: 'x'.repeat(32), COOKIE_SECURE: '0', NO_JOBS: '1', ADMIN_EMAIL: 'admin@vitalmedx.app', ADMIN_PASSWORD: 'admin-pass-123', ADMIN_CHAT_ID: '999', BACKUP_CHAT_ID: '998' };
const root = path.join(__dirname, '..');
function runSync(file) { return new Promise((ok, no) => { const p = spawn(process.execPath, ['--no-warnings', file], { env, cwd: root }); let out = ''; p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (out += d)); p.on('exit', c => (c ? no(new Error(out)) : ok(out))); }); }

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const h = { 'x-requested-with': 'vm' }; if (this.cookie) h.cookie = this.cookie;
    let b; if (body instanceof FormData) b = body; else if (body) { h['content-type'] = 'application/json'; b = JSON.stringify(body); }
    const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers: h, body: b });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(`${method} ${url} → ${r.status} ${j.error}`); e.status = r.status; throw e; } return j;
  }
  login(email, pass) { return this.req('POST', '/api/login', { email, pass }); }
}
const hook = upd => fetch(`http://127.0.0.1:${PORT}/tg/${SECRET}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET }, body: JSON.stringify(upd) });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let upd = 1;
const msg = (from, extra) => ({ update_id: upd++, message: { message_id: upd + 5000, from: { id: from }, chat: { id: from }, date: 0, ...extra } });

(async () => {
  await new Promise(r => tg.listen(TGP, r));
  const seedOut = await runSync('scripts/seed.js');
  const pw = Object.fromEntries([...seedOut.matchAll(/^\S+\s+(\S+@\S+)\s+(\S+)/gm)].map(m => [m[1], m[2]]));
  const srv = spawn(process.execPath, ['--no-warnings', 'src/server.js'], { env, cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.once('data', r));
  let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; };
  try {
    const admin = new Client(); await admin.login('admin@vitalmedx.app', 'admin-pass-123');
    ok((await admin.req('GET', '/api/batches')).length === 19, '19 دفعة');
    // CSRF guard
    await fetch(`http://127.0.0.1:${PORT}/api/logout`, { method: 'POST' }).then(r => ok(r.status === 403, 'csrf'));
    // add doctor
    const d = await admin.req('POST', '/api/users', { name: 'د. تجربة', email: 'dr@test.com', role: 'doctor', password: 'doctor-pass-1', price_theory: 200, price_practical: 250, price_revision: 150, capacity: 2 });
    ok(/^VM-/.test(d.link_code), 'link code');
    // doctor links via bot
    await hook(msg(5551, { text: d.link_code })); await sleep(100);
    ok(tgCalls.some(c => c.method === 'sendMessage' && /اتربط/.test(c.body.text)), 'bot link reply');
    // coordinator walaa sends lecture to 1-1 with PDF
    const walaa = new Client(); await walaa.login('walaa@vitalmedx.app', pw['walaa@vitalmedx.app']);
    const myB = await walaa.req('GET', '/api/batches'); ok(myB.length === 5 && myB.every(b => b.code.startsWith('1-')), 'walaa scope');
    const b11 = myB.find(b => b.code === '1-1');
    const fd = new FormData(); fd.append('batch_id', b11.id); fd.append('doctor_id', d.id); fd.append('type', 'theory'); fd.append('name', 'Anatomy – Lec 01'); fd.append('price', '');
    fd.append('lec', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'lec.pdf');
    const L1 = await walaa.req('POST', '/api/lectures', fd); ok(L1.delivered_to_bot, 'sent to bot');
    const sentMsg = tgCalls.find(c => c.method === 'sendMessage' && /محاضرة جديدة/.test(c.body.text));
    ok(sentMsg && !/1-1|فيصل/.test(sentMsg.body.text) && /200/.test(sentMsg.body.text), 'doctor sees no code, sees price');
    ok(tgCalls.some(c => c.method === 'sendDocument'), 'pdf sent');
    // other coordinator can't send to walaa batch
    const salah = new Client(); await salah.login('salah@vitalmedx.app', pw['salah@vitalmedx.app']);
    await salah.req('POST', '/api/lectures', { batch_id: b11.id, doctor_id: d.id, type: 'theory', name: 'x' }).then(() => ok(false, 'should fail'), e => ok(e.status === 403, 'scope enforced'));
    ok((await salah.req('GET', '/api/lectures')).length === 0, 'salah sees nothing');
    // repeat lecture: price must be typed manually
    await walaa.req('POST', '/api/lectures', { batch_id: b11.id, doctor_id: d.id, type: 'theory', kind: 'repeat', name: 'x' }).then(() => ok(false), e => ok(e.status === 400, 'repeat needs manual price'));
    await walaa.req('POST', '/api/lectures', { batch_id: b11.id, doctor_id: d.id, type: 'repeat', name: 'x', price: 1 }).then(() => ok(false), e => ok(e.status === 400, 'repeat no longer a type'));
    const L2 = await walaa.req('POST', '/api/lectures', { batch_id: b11.id, doctor_id: d.id, type: 'theory', kind: 'repeat', price: 100, name: 'Anatomy – Lec 01 (معادة)' });
    let l2 = await walaa.req('GET', '/api/lectures/' + L2.id); ok(l2.price === 100 && l2.kind === 'repeat' && l2.type_label === 'نظري · معادة', 'repeat manual price + kind');
    const LC = await walaa.req('POST', '/api/lectures', { batch_id: b11.id, doctor_id: d.id, type: 'practical', kind: 'continue', name: 'Physio – part 2' });
    ok((await walaa.req('GET', '/api/lectures/' + LC.id)).price === 250, 'continue uses type price'); await admin.req('PATCH', '/api/lectures/' + LC.id, { action: 'cancel' });
    // doctor delivers video for L1
    tgCalls.length = 0;
    await hook(msg(5551, { video: { file_id: 'VID1', mime_type: 'video/mp4' } })); await sleep(100);
    const kb = tgCalls.find(c => c.body.reply_markup && c.body.reply_markup.inline_keyboard);
    ok(kb && kb.body.reply_markup.inline_keyboard.length === 2, 'picker lists 2 lectures');
    const cb = kb.body.reply_markup.inline_keyboard.find(r => r[0].callback_data.endsWith(':' + L1.id))[0].callback_data;
    await hook({ update_id: upd++, callback_query: { id: 'q1', from: { id: 5551 }, data: cb, message: { message_id: 1, chat: { id: 5551 } } } }); await sleep(100);
    await hook(msg(5551, { document: { file_id: 'QF1', mime_type: 'application/pdf' } })); await sleep(100);
    const kb2 = tgCalls.filter(c => c.body.reply_markup && c.body.reply_markup.inline_keyboard).pop();
    const cb2 = kb2.body.reply_markup.inline_keyboard.find(r => r[0].callback_data.endsWith(':' + L1.id))[0].callback_data;
    await hook({ update_id: upd++, callback_query: { id: 'q2', from: { id: 5551 }, data: cb2, message: { message_id: 2, chat: { id: 5551 } } } }); await sleep(100);
    let l1 = await walaa.req('GET', '/api/lectures/' + L1.id); ok(l1.video_at && l1.q_at && l1.state === 'review', 'delivered → review');
    // approve, rate, upload
    await walaa.req('PATCH', '/api/lectures/' + L1.id, { action: 'approve', video: true, q: true });
    await walaa.req('PATCH', '/api/lectures/' + L1.id, { action: 'rate', r_video: 38, r_q: 9, r_instr: 10, r_comm: 5 });
    await walaa.req('PATCH', '/api/lectures/' + L1.id, { action: 'uploaded' });
    l1 = await walaa.req('GET', '/api/lectures/' + L1.id); ok(l1.state === 'done', 'done');
    // price edit logged + doctor notified
    await walaa.req('PATCH', '/api/lectures/' + L2.id, { action: 'price', price: 120 });
    l2 = await walaa.req('GET', '/api/lectures/' + L2.id); ok(l2.price === 120 && l2.price_log.length === 1, 'price log');
    // doctor dashboard hides codes
    const doc = new Client(); await doc.login('dr@test.com', 'doctor-pass-1');
    const dls = await doc.req('GET', '/api/lectures'); ok(dls.length === 2 && dls.every(l => !('batch_code' in l) && !('university' in l)), 'doctor no codes');
    await doc.req('GET', '/api/batches').then(() => ok(false), e => ok(e.status === 403, 'doctor no batches'));
    // ticket flow
    const cs = new Client(); await cs.login('cs1@vitalmedx.app', pw['cs1@vitalmedx.app']);
    const T = await cs.req('POST', '/api/tickets', { kind: 'question', batch_id: b11.id, lecture_id: L1.id, body: 'ليه الـ brachial plexus كده؟', student: 'طالب 1' });
    tgCalls.length = 0;
    const st = await walaa.req('PATCH', '/api/tickets/' + T.id, { action: 'send_doctor' }); ok(st.delivered_to_bot, 'ticket to doctor');
    const qmsg = tgCalls.find(c => c.method === 'sendMessage');
    await hook(msg(5551, { text: 'عشان كذا وكذا', reply_to_message: { message_id: msgId } })); await sleep(100);
    let tk = (await walaa.req('GET', '/api/tickets')).find(t => t.id === T.id); ok(tk.reply === 'عشان كذا وكذا' && tk.stage === 'return', 'doctor replied');
    await walaa.req('PATCH', '/api/tickets/' + T.id, { action: 'return' });
    await cs.req('PATCH', '/api/tickets/' + T.id, { action: 'deliver' });
    tk = (await cs.req('GET', '/api/tickets')).find(t => t.id === T.id); ok(tk.stage === 'closed' && !tk.coord_late && !tk.cs_late, 'ticket closed on time');
    // voice question + voice reply
    const vfd = new FormData(); vfd.append('kind', 'question'); vfd.append('batch_id', b11.id); vfd.append('lecture_id', L1.id); vfd.append('body', '');
    vfd.append('att', new Blob([Buffer.from('VOICEQ')], { type: 'audio/ogg' }), 'q.ogg');
    const VT = await cs.req('POST', '/api/tickets', vfd);
    const attRes = await fetch(`http://127.0.0.1:${PORT}/api/tickets/${VT.id}/attachment`, { headers: { cookie: walaa.cookie } }); ok((await attRes.text()) === 'VOICEQ', 'attachment served');
    tgCalls.length = 0;
    await walaa.req('PATCH', '/api/tickets/' + VT.id, { action: 'send_doctor' });
    const sv = tgCalls.find(c => c.method === 'sendVoice'); ok(sv && /reply_to_message_id/.test(sv.body.text || ''), 'voice sent to doctor as reply');
    await hook(msg(5551, { voice: { file_id: 'VREPLY' }, reply_to_message: { message_id: msgId } })); await sleep(100);
    let vt = (await walaa.req('GET', '/api/tickets')).find(t => t.id === VT.id); ok(vt.reply_file_id === 'VREPLY' && vt.reply_kind === 'voice' && vt.stage === 'return', 'voice reply stored');
    const rf = await fetch(`http://127.0.0.1:${PORT}/api/tickets/${VT.id}/reply-file`, { headers: { cookie: cs.cookie } }); ok((await rf.text()) === 'OGGDATA', 'reply file proxied');
    // full bot flow: CS → coordinator → doctor → coordinator → CS
    const users = await admin.req('GET', '/api/users');
    const codeOf = e => users.find(x => x.email === e).link_code;
    await hook(msg(6001, { text: codeOf('cs1@vitalmedx.app') })); await hook(msg(6002, { text: codeOf('walaa@vitalmedx.app') })); await sleep(100);
    const lastKb = () => tgCalls.filter(c => c.body.reply_markup && c.body.reply_markup.inline_keyboard && c.body.reply_markup.inline_keyboard.length).pop();
    const cbq = async (from, data) => { await hook({ update_id: upd++, callback_query: { id: 'c' + upd, from: { id: from }, data, message: { message_id: 77, chat: { id: from } } } }); await sleep(120); };
    tgCalls.length = 0;
    await hook(msg(6001, { voice: { file_id: 'CSVOICE' }, caption: 'طالب: محمد' })); await sleep(120);
    let kbm = lastKb(); ok(kbm && String(kbm.body.chat_id) === '6001' && /سؤال لدكتور/.test(JSON.stringify(kbm.body.reply_markup)), 'cs asked kind');
    await cbq(6001, kbm.body.reply_markup.inline_keyboard[0][0].callback_data);
    kbm = lastKb(); const bBtn = kbm.body.reply_markup.inline_keyboard.flat().find(x => x.text.startsWith('1-1 '));
    ok(bBtn, 'batch buttons'); await cbq(6001, bBtn.callback_data);
    kbm = lastKb(); const lBtn = kbm.body.reply_markup.inline_keyboard.flat().find(x => x.callback_data.endsWith(':' + L1.id)); ok(lBtn, 'lecture buttons'); ok(kbm.body.reply_markup.inline_keyboard.flat().some(x => x.callback_data.startsWith('tg:')), 'general doctor option shown');
    tgCalls.length = 0; await cbq(6001, lBtn.callback_data);
    const askS = tgCalls.find(c => /اسم الطالب/.test(c.body.text || '')); ok(askS && /ts:/.test(JSON.stringify(askS.body.reply_markup)), 'bot asks student name with skip');
    tgCalls.length = 0; await hook(msg(6001, { text: 'أحمد 0555123456' })); await sleep(150);
    const prK = tgCalls.find(c => /الأولوية/.test(c.body.text || '')); ok(prK, 'bot asks priority');
    tgCalls.length = 0; await cbq(6001, prK.body.reply_markup.inline_keyboard[0][0].callback_data);
    const dueK = tgCalls.find(c => /خلال قد إيه/.test(c.body.text || '')); ok(dueK, 'bot asks deadline');
    tgCalls.length = 0; await cbq(6001, dueK.body.reply_markup.inline_keyboard[1][1].callback_data); await sleep(100);
    const toCoord = tgCalls.find(c => String(c.body.chat_id) === '6002' && /سؤال جديد/.test(c.body.text || '')); ok(toCoord, 'coordinator notified');
    ok(tgCalls.some(c => c.method === 'sendVoice' && String(c.body.chat_id) === '6002' && c.body.voice === 'CSVOICE'), 'coordinator got voice');
    const tdBtn = toCoord.body.reply_markup.inline_keyboard[0][0]; ok(tdBtn.text.includes('د. تجربة'), 'lecture doctor first');
    const btid = Number(tdBtn.callback_data.split(':')[1]);
    tgCalls.length = 0; await cbq(6002, tdBtn.callback_data);
    const dq = tgCalls.find(c => String(c.body.chat_id) === '5551' && /سؤال من طالب/.test(c.body.text || '')); ok(dq, 'doctor got question');
    ok(tgCalls.some(c => c.method === 'sendVoice' && String(c.body.chat_id) === '5551' && c.body.reply_to_message_id), 'doctor got voice as reply');
    tgCalls.length = 0;
    await hook(msg(5551, { text: 'الإجابة كذا', reply_to_message: { message_id: dq ? msgId - 1 : 0 } })); await sleep(150);
    const toC2 = tgCalls.find(c => String(c.body.chat_id) === '6002' && /رد على السؤال/.test(c.body.text || '')); ok(toC2 && /الإجابة كذا/.test(toC2.body.text), 'coordinator got reply');
    tgCalls.length = 0; await cbq(6002, toC2.body.reply_markup.inline_keyboard[0][0].callback_data);
    const toCs = tgCalls.find(c => String(c.body.chat_id) === '6001' && /رد جاهز للطالب/.test(c.body.text || '')); ok(toCs, 'cs got reply');
    await cbq(6001, toCs.body.reply_markup.inline_keyboard[0][0].callback_data);
    const bt = (await admin.req('GET', '/api/tickets')).find(t => t.id === btid); ok(bt.stage === 'closed' && bt.att_kind === 'voice' && bt.lecture_id === L1.id && bt.student === 'أحمد 0555123456', 'bot flow closed (with student)');
    ok(bt.priority === 3 && bt.due_at && Math.abs(bt.due_at - bt.created_at - 24 * 3600e3) < 5000, 'priority + 24h deadline from bot');
    const attB = await fetch(`http://127.0.0.1:${PORT}/api/tickets/${btid}/attachment`, { headers: { cookie: cs.cookie } }); ok((await attB.text()) === 'OGGDATA', 'tg attachment proxied');
    // payout + contact + admin notify + finance message
    tgCalls.length = 0;
    await doc.req('PUT', '/api/me/contact', { tg_username: '@drtest', whatsapp: '01012345678' });
    await doc.req('POST', '/api/me/payout', { kind: 'vodafone', name: 'د تجربة', number: '01012345678' });
    await doc.req('POST', '/api/me/payout', { kind: 'bank', name: 'د تجربة', bank: 'CIB', iban: 'EG00123' });
    await doc.req('POST', '/api/me/payout', { kind: 'bank', name: 'x' }).then(() => ok(false), e => ok(e.status === 400, 'bank needs fields'));
    ok(tgCalls.filter(c => c.body.chat_id === '999' && /تنبيه/.test(c.body.text || '')).length >= 3, 'admin notified of changes');
    ok((await admin.req('GET', '/api/home')).alerts.some(a => a.type === 'profile'), 'profile alert');
    let fd2 = await admin.req('GET', '/api/finance/' + d.id); ok(fd2.payout.length === 2 && fd2.user.whatsapp === '01012345678' && fd2.user.tg_username === 'drtest', 'finance shows payout+contact');
    const rfd = new FormData(); rfd.append('note', 'اتحوّل ✓'); rfd.append('receipt', new Blob([Buffer.from('PNG')], { type: 'image/png' }), 'r.png');
    tgCalls.length = 0; const mr2 = await admin.req('POST', `/api/finance/${d.id}/message`, rfd); ok(mr2.delivered && tgCalls.some(c => c.method === 'sendPhoto'), 'receipt sent');
    let trs = await doc.req('GET', '/api/me/transfers'); ok(trs.length === 1 && trs[0].needs_confirm === 1, 'doctor sees transfer msg (needs confirm)');
    ok(tgCalls.some(c => c.method === 'sendPhoto' && /rc:/.test(c.body.text || '')), 'receipt has confirm buttons');
    tgCalls.length = 0; await cbq(5551, 'rc:' + trs[0].id);
    ok((await doc.req('GET', '/api/me/transfers'))[0].confirmed_at && tgCalls.some(c => c.body.chat_id === '999' && /أكد استلام/.test(c.body.text || '')), 'confirmed via bot + admin told');
    const nfd = new FormData(); nfd.append('note', 'اتحوّل 500'); nfd.append('confirm', '1');
    tgCalls.length = 0; await admin.req('POST', `/api/finance/${d.id}/message`, nfd);
    const trMsg = tgCalls.find(c => c.method === 'sendMessage' && String(c.body.chat_id) === '5551'); ok(trMsg && /rx:/.test(JSON.stringify(trMsg.body.reply_markup)), 'note asks confirm');
    const tr2 = (await doc.req('GET', '/api/me/transfers'))[0];
    tgCalls.length = 0; await cbq(5551, 'rx:' + tr2.id);
    const fr = tgCalls.find(c => c.body.reply_markup && c.body.reply_markup.force_reply); ok(fr, 'problem prompt');
    tgCalls.length = 0; await hook(msg(5551, { text: 'التحويل ماوصلش', reply_to_message: { message_id: msgId } })); await sleep(150);
    ok((await doc.req('GET', '/api/me/transfers'))[0].problem === 'التحويل ماوصلش' && tgCalls.some(c => c.body.chat_id === '999' && /مشكلة في التحويل/.test(c.body.text || '')), 'transfer problem recorded + admin told');
    ok((await admin.req('GET', '/api/home')).alerts.some(a => a.type === 'transfer'), 'transfer alert');
    const nfd2 = new FormData(); nfd2.append('note', 'تجربة'); nfd2.append('confirm', '0'); await admin.req('POST', `/api/finance/${d.id}/message`, nfd2);
    const tr3 = (await doc.req('GET', '/api/me/transfers'))[0]; await doc.req('POST', `/api/me/transfers/${tr3.id}/confirm`); ok(tr3.needs_confirm === 0, 'confirm optional');
    const fl = (await admin.req('GET', '/api/finance')).rows; ok(fl.every((r, i) => i === 0 || r.net <= fl[i - 1].net), 'finance sorted desc');
    // problem
    const P = await cs.req('POST', '/api/tickets', { kind: 'problem', batch_id: b11.id, body: 'الفيديو مش شغال' });
    await walaa.req('PATCH', '/api/tickets/' + P.id, { action: 'close', resolution: 'اترفع تاني' });
    // checklist + supervisor report
    await walaa.req('PUT', '/api/checklist', { item: 'new_data', done: true, note: 'بعت 2 محاضرة' });
    await walaa.req('PUT', '/api/checklist', { item: 'ideas', done: true, note: 'خصم للدفعة' });
    const sup = new Client(); await sup.login('mohamed.saleh@vitalmedx.app', pw['mohamed.saleh@vitalmedx.app']);
    const rep = await sup.req('GET', '/api/reports'); const w = rep.team.find(c => c.name === 'ولاء');
    ok(w && w.report.items.find(i => i.key === 'new_data').done && w.report.items.find(i => i.key === 'ideas').done, 'supervisor sees checklist');
    ok(!rep.team.some(c => c.name === 'صلاح'), 'supervisor scope');
    await sup.req('PUT', '/api/reports', { body: 'يوم كويس' });
    const menna = new Client(); await menna.login('menna@vitalmedx.app', pw['menna@vitalmedx.app']);
    ok((await menna.req('GET', '/api/batches')).every(b => b.supervisor === 'د. منة'), 'menna scope');
    // subs + exam alert
    await cs.req('POST', '/api/subs', { rows: [{ batch_id: b11.id, count: 40 }] });
    await admin.req('PATCH', '/api/batches/' + b11.id, { expected_subs: 50 });
    const in5 = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    await walaa.req('PATCH', '/api/batches/' + b11.id, { exam_date: in5 });
    const home = await admin.req('GET', '/api/home'); ok(home.alerts.some(a => a.type === 'exam'), 'exam alert');
    // overdue lecture via direct DB + reminders job
    process.env.DATA_DIR = DATA; const { run } = require('../src/db');
    run('UPDATE lectures SET sent_at=? WHERE id=?', Date.now() - 25 * 36e5, L2.id);
    const h2 = await walaa.req('GET', '/api/home'); ok(h2.alerts.some(a => a.type === 'late' && a.lecture_id === L2.id), 'late alert');
    // penalties: coordinator proposes, admin approves → doctor notified, doctor objects
    const pen = await walaa.req('POST', '/api/penalties', { user_id: d.id, reason: 'تأخير', kind: 'خصم', amount: 50 });
    tgCalls.length = 0;
    await admin.req('PATCH', '/api/penalties/' + pen.id, { action: 'approve' }); await sleep(50);
    ok(tgCalls.some(c => /قرار إداري/.test(c.body.text || '')), 'penalty notified');
    await doc.req('PATCH', '/api/penalties/' + pen.id, { action: 'object', text: 'كان عندي ظرف' });
    // finance: doctor payable = 200 (L1 delivered) − 50; L2 not delivered → rolls over
    let f = await admin.req('GET', '/api/finance/' + d.id); ok(f.gross === 200 && f.deductions === 50 && f.net === 150 && f.pendingLecs === 1, 'finance calc');
    await admin.req('POST', '/api/bonuses', { user_id: d.id, amount: 30, note: 'شغل حلو' });
    const s = await admin.req('POST', `/api/finance/${d.id}/settle`, { kind: 'early' }); ok(s.net === 180, 'settle net');
    f = await admin.req('GET', '/api/finance/' + d.id); ok(f.net === 0 && f.settlements.length === 1 && f.pendingLecs === 1, 'after settle');
    // cs variable pay
    const cs2id = (await admin.req('GET', '/api/users')).find(u => u.email === 'cs2@vitalmedx.app').id;
    await admin.req('POST', '/api/extra', { user_id: cs2id, amount: 3000, note: 'شهر نوفمبر' });
    ok((await admin.req('GET', '/api/finance')).rows.find(r => r.id === cs2id).net === 3000, 'extra pay');
    // month history + statement PDF + period-limited close
    const L_ = require('../src/logic'), curM = L_.dayStr().slice(0, 7), [yy, mm] = curM.split('-').map(Number), prevM = mm === 1 ? `${yy - 1}-12` : `${yy}-${String(mm - 1).padStart(2, '0')}`;
    ok((await admin.req('GET', `/api/finance/${d.id}?period=${prevM}`)).lecs.length === 0, 'prev month excludes lectures sent this month');
    const sc = await admin.req('POST', `/api/finance/${cs2id}/settle`, { kind: 'month', period: prevM }); ok(sc.net === 3000, 'settle prev month');
    await admin.req('POST', `/api/finance/${cs2id}/settle`, { kind: 'month', period: 'bad' }).then(() => ok(false), e => ok(e.status === 400, 'period validated'));
    const hist = await admin.req('GET', '/api/finance?month=' + prevM); ok(hist.history && hist.rows.some(r => r.id === cs2id && r.net === 3000 && r.unpaid === 1) && hist.open.some(x => x.id === d.id), 'month history');
    ok(!(await admin.req('GET', '/api/finance')).history, 'current month live');
    const pdfR = await fetch(`http://127.0.0.1:${PORT}/api/settlements/${sc.id}/pdf`, { headers: { cookie: admin.cookie } }); const pdfB = Buffer.from(await pdfR.arrayBuffer());
    ok(pdfR.headers.get('content-type') === 'application/pdf' && pdfB.slice(0, 5).toString() === '%PDF-' && pdfB.length < 200000, 'statement pdf');
    const dpdf = await fetch(`http://127.0.0.1:${PORT}/api/settlements/${s.id}/pdf`, { headers: { cookie: doc.cookie } }); ok(dpdf.status === 200, 'doctor gets own statement');
    const xpdf = await fetch(`http://127.0.0.1:${PORT}/api/settlements/${sc.id}/pdf`, { headers: { cookie: doc.cookie } }); ok(xpdf.status === 403, 'not others statements');
    const sfd = new FormData(); sfd.append('note', 'حساب الشهر'); sfd.append('settlement_id', String(s.id));
    tgCalls.length = 0; await admin.req('POST', `/api/finance/${d.id}/message`, sfd); ok(tgCalls.some(c => c.method === 'sendDocument' && /PDF|pdf/.test(c.body.text || '')), 'statement sent with transfer');
    // team + prompt
    const team = await admin.req('GET', '/api/team'); ok(team.coordinators.length === 5 && team.supervisors.length === 2 && team.cs.length === 2, 'team');
    const pr = await admin.req('GET', '/api/prompt'); ok(/1-1/.test(pr.text) && /د. تجربة/.test(pr.text) && /المطلوب/.test(pr.text), 'prompt');
    // jobs: reminders / daily report / backup
    process.env.TG_API = env.TG_API; process.env.BOT_TOKEN = 'TEST'; process.env.BACKUP_CHAT_ID = '998'; process.env.ADMIN_CHAT_ID = '999';
    const jobs = require('../src/jobs'); tgCalls.length = 0;
    await jobs.reminders(); ok(tgCalls.some(c => /مهلة المحاضرة/.test(c.body.text || '')), 'overdue reminder');
    const la = tgCalls.filter(c => /⚠️ تأخير/.test(c.body.text || ''));
    ok(la.some(c => String(c.body.chat_id) === '6002') && la.some(c => String(c.body.chat_id) === '999') && /1-1/.test(la[0].body.text) && /ولاء/.test(la[0].body.text), 'late alert to coordinator + admin at once');
    ok(!tgCalls.some(c => String(c.body.chat_id) === '5551' && /1-1|دفعة/.test(c.body.text || '')), 'doctor alert hides batch');
    tgCalls.length = 0; await jobs.reminders(); ok(!tgCalls.some(c => /تأخير/.test(c.body.text || '')), 'late alert only once');
    const bk = await jobs.backup(); ok(bk && fs.existsSync(bk), 'backup file'); ok(tgCalls.some(c => c.method === 'sendDocument' && c.body.multipart), 'backup sent');
    // webhook secret enforced
    const bad = await fetch(`http://127.0.0.1:${PORT}/tg/${SECRET}`, { method: 'POST', body: '{}' }); ok(bad.status === 404, 'webhook needs header');
    // exemption: lecture without question file closes on video only
    const LX = await walaa.req('POST', '/api/lectures', { batch_id: b11.id, doctor_id: d.id, type: 'practical', name: 'Practical – no Q', no_q: true });
    tgCalls.length = 0;
    await hook(msg(5551, { document: { file_id: 'QQ', mime_type: 'application/pdf' } })); await sleep(100);
    const kq = tgCalls.filter(c => c.body.reply_markup && c.body.reply_markup.inline_keyboard).pop();
    ok(!kq || !kq.body.reply_markup.inline_keyboard.some(r => r[0].callback_data.endsWith(':' + LX.id)), 'exempt lecture not offered for Q');
    await hook(msg(5551, { video: { file_id: 'VX', mime_type: 'video/mp4' } })); await sleep(100);
    const kv = tgCalls.filter(c => c.body.reply_markup && c.body.reply_markup.inline_keyboard).pop();
    await hook({ update_id: upd++, callback_query: { id: 'qx', from: { id: 5551 }, data: kv.body.reply_markup.inline_keyboard.find(r => r[0].callback_data.endsWith(':' + LX.id))[0].callback_data, message: { message_id: 9, chat: { id: 5551 } } } }); await sleep(100);
    await walaa.req('PATCH', '/api/lectures/' + LX.id, { action: 'approve', video: true });
    let lx = await walaa.req('GET', '/api/lectures/' + LX.id); ok(lx.q_state === 'na' && lx.state === 'upload', 'exempt → upload');
    await walaa.req('PATCH', '/api/lectures/' + L2.id, { action: 'exempt_q' });
    ok((await walaa.req('GET', '/api/lectures/' + L2.id)).q_state === 'na', 'exempt later');
    // rankings + manual override
    const mon = new Date().toISOString().slice(0, 7);
    let rk = await admin.req('GET', '/api/rankings?month=' + mon); ok(rk.lists.coordinator.length === 5 && rk.lists.doctor[0].id === d.id, 'rankings');
    const last = rk.lists.coordinator.at(-1);
    await admin.req('PUT', '/api/rankings', { month: rk.month, role: 'coordinator', user_id: last.id, position: 1 });
    rk = await admin.req('GET', '/api/rankings?month=' + mon); ok(rk.lists.coordinator[0].id === last.id && rk.lists.coordinator[0].manual && rk.lists.coordinator.length === 5, 'manual rank');
    // priority hidden from doctor, supervisor sets priority + excuse + queue
    const LP = await walaa.req('POST', '/api/lectures', { batch_id: b11.id, doctor_id: d.id, type: 'theory', name: 'Urgent one', priority: 3 });
    ok((await walaa.req('GET', '/api/lectures/' + LP.id)).priority === 3, 'priority saved');
    ok(!('priority' in (await doc.req('GET', '/api/lectures/' + LP.id))), 'doctor cannot see priority');
    await sup.req('PATCH', '/api/lectures/' + LP.id, { action: 'priority', priority: 0 });
    ok((await walaa.req('GET', '/api/lectures/' + LP.id)).priority === 0, 'supervisor changed priority');
    await walaa.req('PATCH', '/api/lectures/' + LP.id, { action: 'excuse' }).then(() => ok(false), e => ok(e.status === 403, 'coordinator cannot excuse'));
    run('UPDATE lectures SET sent_at=? WHERE id=?', Date.now() - 30 * 36e5, LP.id);
    ok((await walaa.req('GET', '/api/lectures/' + LP.id)).state === 'late', 'late before excuse');
    await sup.req('PATCH', '/api/lectures/' + LP.id, { action: 'excuse', note: 'اتقدم عليها' });
    ok((await walaa.req('GET', '/api/lectures/' + LP.id)).state === 'progress', 'excused not late');
    await sup.req('POST', `/api/doctors/${d.id}/queue`, { order: [LP.id, L2.id] }); tgCalls.length = 0;
    await hook(msg(5551, { text: '/tasks' })); await sleep(100);
    const tasksTxt = tgCalls.find(c => c.method === 'sendMessage').body.text; ok(tasksTxt.indexOf('#' + LP.id) < tasksTxt.indexOf('#' + L2.id) && !/مهم/.test(tasksTxt), 'queue order in bot, no priority');
    const mr = await walaa.req('GET', '/api/myrank'); ok(mr.rank >= 1 && mr.of === 5, 'myrank');
    // impersonation
    const imp = new Client(); await imp.login('admin@vitalmedx.app', 'admin-pass-123');
    const wid = users.find(x => x.email === 'walaa@vitalmedx.app').id;
    const r1 = await fetch(`http://127.0.0.1:${PORT}/api/impersonate/${wid}`, { method: 'POST', headers: { cookie: imp.cookie, 'x-requested-with': 'vm' } });
    const ck = r1.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const meI = await fetch(`http://127.0.0.1:${PORT}/api/me`, { headers: { cookie: ck } }).then(r => r.json()); ok(meI.name === 'ولاء' && meI.impersonated_by === 'الأدمن', 'impersonating');
    const bsI = await fetch(`http://127.0.0.1:${PORT}/api/batches`, { headers: { cookie: ck } }).then(r => r.json()); ok(bsI.length === 5, 'impersonated scope');
    await fetch(`http://127.0.0.1:${PORT}/api/checklist`, { method: 'PUT', headers: { cookie: ck, 'x-requested-with': 'vm', 'content-type': 'application/json' }, body: JSON.stringify({ item: 'post', done: true }) });
    const r2 = await fetch(`http://127.0.0.1:${PORT}/api/impersonate-stop`, { method: 'POST', headers: { cookie: ck, 'x-requested-with': 'vm' } });
    const ck2 = r2.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !c.endsWith('=')).join('; ');
    const meB = await fetch(`http://127.0.0.1:${PORT}/api/me`, { headers: { cookie: ck2 } }).then(r => r.json()); ok(meB.role === 'admin' && !meB.impersonated_by, 'back to admin');
    await walaa.req('POST', `/api/impersonate/${d.id}`).then(() => ok(false), e => ok(e.status === 403, 'non-admin cannot impersonate'));
    // auto daily report
    const dr = await admin.req('GET', '/api/daily-report');
    const lr = dr.late.find(x => x.id === L2.id); ok(lr && lr.coordinator === 'ولاء' && lr.supervisor !== '—' && lr.doctor === 'د. تجربة' && lr.missing.includes('الفيديو'), 'report: late with owners');
    ok(!dr.late.some(x => x.id === LP.id), 'report: excused not late');
    ok(dr.team.some(x => x.role === 'coordinator' && x.missing.length) && dr.team.some(x => x.role === 'supervisor') && dr.delivered.n >= 1 && dr.delivered.total > 0, 'report: team + delivered');
    ok(/تقرير/.test(dr.text) && /متأخرة/.test(dr.text), 'report text');
    const drs = await sup.req('GET', '/api/daily-report'); ok(drs.team.every(x => x.role === 'coordinator'), 'supervisor report scoped');
    await walaa.req('GET', '/api/daily-report').then(() => ok(false), e => ok(e.status === 403, 'coordinator no report'));
    ok(/التاسكات الناقصة/.test(jobs.dailySummaryText()), 'daily telegram uses new report');
    // doctor notes (hidden from doctor)
    await walaa.req('POST', `/api/doctors/${d.id}/notes`, { body: 'شرحه سريع' });
    ok((await admin.req('GET', '/api/doctors/' + d.id)).notes.some(n => n.body === 'شرحه سريع' && n.author === 'ولاء'), 'note visible to admin');
    ok(!('notes' in (await doc.req('GET', '/api/doctors/' + d.id))), 'doctor cannot see notes');
    await doc.req('POST', `/api/doctors/${d.id}/notes`, { body: 'x' }).then(() => ok(false), e => ok(e.status === 403, 'doctor cannot add note'));
    const nid = (await sup.req('GET', '/api/doctors/' + d.id)).notes[0].id;
    await sup.req('DELETE', '/api/notes/' + nid).then(() => ok(false), e => ok(e.status === 403, 'only author/admin deletes'));
    await admin.req('DELETE', '/api/notes/' + nid); ok((await admin.req('GET', '/api/doctors/' + d.id)).notes.length === 0, 'admin deleted note');
    // audit log
    const au = await admin.req('GET', '/api/audit'); ok(au.rows.some(a => a.what === 'بعت محاضرة جديدة' && a.name === 'ولاء'), 'audit: lecture send');
    ok(au.rows.some(a => a.what === 'حدّث مهام اليوم' && a.admin_name), 'audit: impersonated action flagged');
    ok(au.rows.some(a => /البوت/.test(a.what)), 'audit: bot actions');
    ok(!au.rows.some(a => /pass/.test(JSON.stringify(a))), 'audit: no passwords');
    await walaa.req('GET', '/api/audit').then(() => ok(false), e => ok(e.status === 403, 'audit admin only'));
    // ===== v1.7 =====
    const DB = require('../src/db'), Lg = require('../src/logic'), D_ = Lg.deadline();
    // general question straight to a doctor (dashboard) + urgent + deadline
    tgCalls.length = 0;
    const gq = await cs.req('POST', '/api/tickets', { kind: 'question', batch_id: b11.id, doctor_id: d.id, body: 'سؤال عام في الفسيولوجي', student: 'منى', priority: 3, due_hours: 2 });
    ok(gq.direct && gq.delivered_to_bot, 'general question sent directly');
    const toDoc = tgCalls.find(c => String(c.body.chat_id) === '5551' && /سؤال من طالب/.test(c.body.text || '')); ok(toDoc && /مستعجل/.test(toDoc.body.text) && !/1-1|منى/.test(toDoc.body.text), 'doctor sees urgent, no batch/student');
    await sleep(100); ok(tgCalls.some(c => String(c.body.chat_id) === '6002' && /اتبعت مباشرة/.test(c.body.text || '')), 'coordinator informed of direct question');
    const myq = await doc.req('GET', '/api/my-questions'); const mq = myq.find(x => x.id === gq.id);
    ok(mq && mq.urgent && mq.due_at && !('batch_id' in mq) && !('student' in mq) && !('priority' in mq), 'doctor dashboard lists question safely');
    const rfd7 = new FormData(); rfd7.append("reply", "الإجابة كذا"); rfd7.append('file', new Blob([Buffer.from('OggS fake')], { type: 'audio/ogg' }), 'r.ogg');
    tgCalls.length = 0; await doc.req("POST", `/api/my-questions/${gq.id}/reply`, rfd7); await sleep(100);
    ok(tgCalls.some(c => String(c.body.chat_id) === '6002' && /رد على السؤال/.test(c.body.text || '')) && tgCalls.some(c => c.method === 'sendVoice'), 'dashboard reply reaches coordinator with voice');
    await doc.req('POST', `/api/my-questions/${gq.id}/reply`, { reply: 'x' }).then(() => ok(false), e => ok(e.status === 400, 'no double reply'));
    const rf7 = await fetch(`http://127.0.0.1:${PORT}/api/tickets/${gq.id}/reply-file`, { headers: { cookie: doc.cookie } }); ok(rf7.status === 200, "doctor plays own reply");
    // supervisor takes over the late coordinator step
    await sup.req('PATCH', '/api/tickets/' + gq.id, { action: 'priority', priority: 2 });
    DB.run('UPDATE tickets SET reply_at=? WHERE id=?', Date.now() - 3 * 3600e3, gq.id);
    await sup.req('PATCH', '/api/tickets/' + gq.id, { action: 'return' });
    const gt = (await admin.req('GET', '/api/tickets')).find(x => x.id === gq.id);
    ok(gt.by.returned.role === 'supervisor' && gt.coord_late && gt.both_late && gt.priority === 2, 'supervisor did it, late on both');
    const LS = await walaa.req('POST', '/api/lectures', { batch_id: b11.id, doctor_id: d.id, type: 'theory', name: 'Sup takeover' });
    DB.run('UPDATE lectures SET video_at=?, q_at=? WHERE id=?', Date.now(), Date.now(), LS.id);
    await sup.req('PATCH', '/api/lectures/' + LS.id, { action: 'approve', video: true, q: true });
    DB.run('UPDATE lectures SET video_ok_at=?, q_ok_at=? WHERE id=?', Date.now() - 2 * 3600e3, Date.now() - 2 * 3600e3, LS.id);
    tgCalls.length = 0; await jobs.reminders();
    ok(tgCalls.some(c => String(c.body.chat_id) === '6002' && /متأخر: محاضرة/.test(c.body.text || '')), 'upload alert to coordinator');
    await sup.req('PATCH', '/api/lectures/' + LS.id, { action: 'uploaded' });
    const ls_ = await sup.req('GET', '/api/lectures/' + LS.id); ok(/المشرف/.test(ls_.uploaded_by_name) && /المشرف/.test(ls_.ok_by_name) && ls_.upload_late, 'lecture shows supervisor did it');
    ok((await doc.req('GET', '/api/lectures/' + LS.id)).uploaded_by_name === undefined, 'doctor not shown who uploaded');
    await admin.req('PATCH', '/api/lectures/' + LS.id, { action: 'cancel' });
    // supervisor has every coordinator permission on his batches
    const SL = await sup.req('POST', '/api/lectures', { batch_id: b11.id, doctor_id: d.id, type: 'revision', name: 'Sent by supervisor' }); ok(SL.id, 'supervisor sends lecture');
    await sup.req('PATCH', '/api/lectures/' + SL.id, { action: 'price', price: 123 }); ok((await sup.req('GET', '/api/lectures/' + SL.id)).price === 123, 'supervisor edits price');
    await sup.req('PATCH', '/api/lectures/' + SL.id, { action: 'cancel' }).then(() => ok(false), e => ok(e.status === 403, 'delete stays admin-only'));
    ok((await sup.req('POST', '/api/tickets', { kind: 'problem', batch_id: b11.id, body: 'مشكلة من المشرف' })).id, 'supervisor opens ticket');
    const supId = (await sup.req('GET', '/api/me')).id, notMine = (await admin.req('GET', '/api/batches')).find(b => b.supervisor_id && b.supervisor_id !== supId);
    if (notMine) await sup.req('POST', '/api/lectures', { batch_id: notMine.id, doctor_id: d.id, type: 'theory', name: 'x' }).then(() => ok(false), e => ok(e.status === 403, 'supervisor limited to his batches'));
    await admin.req('PATCH', '/api/lectures/' + SL.id, { action: 'cancel' });
    // configurable reminders before deadline + one late alert per day
    await admin.req('PUT', '/api/settings', { remind_before_hours: '6, 3, 1' });
    await admin.req('PUT', '/api/settings', { upload_alert_minutes: '6,x' }).then(() => ok(false), e => ok(e.status === 400, 'alert list validated'));
    const LR = await walaa.req('POST', '/api/lectures', { batch_id: b11.id, doctor_id: d.id, type: 'theory', name: 'Remind test' });
    DB.run('UPDATE lectures SET sent_at=? WHERE id=?', Date.now() - D_ + 2 * 3600e3, LR.id);
    const rem = () => tgCalls.filter(c => String(c.body.chat_id) === '5551' && new RegExp(`تذكير.*#${LR.id}`).test(c.body.text || '')).length;
    tgCalls.length = 0; await jobs.reminders(); ok(rem() === 1, 'reminder at 3h mark (6h & 3h passed → one msg)');
    tgCalls.length = 0; await jobs.reminders(); ok(rem() === 0, 'not repeated');
    DB.run('UPDATE lectures SET sent_at=? WHERE id=?', Date.now() - D_ + 0.5 * 3600e3, LR.id);
    tgCalls.length = 0; await jobs.reminders(); ok(rem() === 1, 'second reminder at 1h');
    DB.run('UPDATE lectures SET sent_at=? WHERE id=?', Date.now() - D_ - 60e3, LR.id);
    tgCalls.length = 0; await jobs.reminders(); ok(tgCalls.some(c => /⚠️ تأخير/.test(c.body.text || '') && c.body.text.includes('Remind test')), 'late day 1');
    tgCalls.length = 0; await jobs.reminders(); ok(!tgCalls.some(c => (c.body.text || '').includes('Remind test')), 'once per day');
    DB.run('UPDATE lectures SET sent_at=? WHERE id=?', Date.now() - D_ - 25 * 3600e3, LR.id);
    tgCalls.length = 0; await jobs.reminders(); ok(tgCalls.some(c => /اليوم 2/.test(c.body.text || '') && c.body.text.includes('Remind test')), 'late day 2');
    await jobs.reminders(true); // silent priming must not send
    // ticket deadline passed → everyone
    const tq2 = await cs.req('POST', '/api/tickets', { kind: 'problem', batch_id: b11.id, body: 'مشكلة مستعجلة', due_hours: 1, priority: 3 });
    DB.run('UPDATE tickets SET due_at=? WHERE id=?', Date.now() - 60e3, tq2.id);
    tgCalls.length = 0; await jobs.reminders(); ok(tgCalls.some(c => c.body.chat_id === '999' && /عدّى المهلة/.test(c.body.text || '')), 'due passed alert');
    ok((await admin.req('GET', '/api/daily-report')).lateQ.some(x => x.id === tq2.id), 'due late in daily report');
    // forgot password via bot code
    tgCalls.length = 0; const fr7 = await new Client().req("POST", "/api/forgot", { email: "dr@test.com" }); ok(fr7.ok, 'forgot ok');
    const codeMsg = tgCalls.find(c => String(c.body.chat_id) === '5551' && /كود/.test(c.body.text || '')); const code = codeMsg && codeMsg.body.text.match(/\d{6}/)[0]; ok(code, 'code sent on telegram');
    ok((await new Client().req('POST', '/api/forgot', { email: 'nobody@x.com' })).ok, 'unknown email same answer');
    await new Client().req('POST', '/api/forgot/reset', { email: 'dr@test.com', code: '000000', pass: 'new-pass-123' }).then(() => ok(false), e => ok(e.status === 400, 'wrong code'));
    await new Client().req('POST', '/api/forgot/reset', { email: 'dr@test.com', code, pass: 'new-pass-123' });
    const dn = new Client(); await dn.login('dr@test.com', 'new-pass-123'); ok((await dn.req('GET', '/api/me')).role === 'doctor', 'login with new password');
    await new Client().req('POST', '/api/forgot/reset', { email: 'dr@test.com', code, pass: 'other-pass-123' }).then(() => ok(false), e => ok(e.status === 400, 'code single use'));
    // undo settlement
    const st1 = (await admin.req('GET', '/api/finance/' + d.id)).settlements[0];
    await admin.req('DELETE', '/api/settlements/' + st1.id);
    ok((await admin.req('GET', '/api/finance/' + d.id)).net === 180 + 250, 'settlement undone (+ exempt lecture 250)');
    // reset everything
    await admin.req('POST', '/api/reset', { confirm: 'غلط' }).then(() => ok(false), e => ok(e.status === 400, 'reset needs phrase'));
    await admin.req('POST', '/api/reset', { confirm: 'امسح كل حاجة', doctors: true });
    ok((await admin.req('GET', '/api/lectures')).length === 0 && (await admin.req('GET', '/api/tickets')).length === 0 && (await admin.req('GET', '/api/doctors')).length === 0, 'reset');
    ok((await admin.req('GET', '/api/batches')).length === 19, 'structure kept');
    // static
    const html = await fetch(`http://127.0.0.1:${PORT}/`).then(r => r.text()); ok(html.includes('app.js'), 'static');
    console.log(`\n✓ ${pass} اختبار نجحوا`);
  } catch (e) { console.error('\n✗', e); process.exitCode = 1; }
  finally { srv.kill(); tg.close(); }
})();
