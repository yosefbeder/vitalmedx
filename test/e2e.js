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
    let body = {}; try { body = JSON.parse(raw.toString()); } catch { body = { multipart: true, size: raw.length, text: raw.toString('latin1').slice(0, 300) }; }
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
    // repeat lecture default half price
    const L2 = await walaa.req('POST', '/api/lectures', { batch_id: b11.id, doctor_id: d.id, type: 'repeat', name: 'Anatomy – Lec 01 (معادة)' });
    let l2 = await walaa.req('GET', '/api/lectures/' + L2.id); ok(l2.price === 100, 'repeat half price');
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
    ok((await admin.req('GET', '/api/finance')).find(r => r.id === cs2id).net === 3000, 'extra pay');
    // team + prompt
    const team = await admin.req('GET', '/api/team'); ok(team.coordinators.length === 5 && team.supervisors.length === 2 && team.cs.length === 2, 'team');
    const pr = await admin.req('GET', '/api/prompt'); ok(/1-1/.test(pr.text) && /د. تجربة/.test(pr.text) && /المطلوب/.test(pr.text), 'prompt');
    // jobs: reminders / daily report / backup
    process.env.TG_API = env.TG_API; process.env.BOT_TOKEN = 'TEST'; process.env.BACKUP_CHAT_ID = '998';
    const jobs = require('../src/jobs'); tgCalls.length = 0;
    await jobs.reminders(); ok(tgCalls.some(c => /مهلة المحاضرة/.test(c.body.text || '')), 'overdue reminder');
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
