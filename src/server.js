'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { one, all, run, setting, audit, tx } = require('./db');
const A = require('./auth');
const L = require('./logic');
const bot = require('./bot');
const jobs = require('./jobs');
const PDF = require('./pdf');
const { DATA_DIR } = require('./db');
const ATT = path.join(DATA_DIR, 'attachments'); fs.mkdirSync(ATT, { recursive: true });

const VERSION = '1.7.0';
const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');
const WEBHOOK = process.env.WEBHOOK_SECRET || '';
const MAX_BODY = 50 * 1024 * 1024;

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };
const need = (u, ...roles) => { if (!roles.includes(u.role)) fail(403, 'مش مسموح'); };
const int = v => (v === '' || v == null ? null : Number.parseInt(v, 10));
const real = v => (v === '' || v == null ? null : Number(v));
const str = (v, max = 4000) => (v == null ? null : String(v).trim().slice(0, max));
const req1 = (v, name) => { if (v == null || v === '' || Number.isNaN(v)) fail(400, `${name} مطلوب`); return v; };

const canTicket = (u, t) => canBatch(u, t.batch_id) || (u.role === 'doctor' && t.doctor_id === u.id && !!t.sent_doctor_at);
const PRI = v => Math.max(0, Math.min(3, int(v) ?? 1));
function dueFrom(body) { // hours (number) or custom hours; '' / 0 = no deadline
  const h = real(body.due_hours); return h && h > 0 ? Date.now() + Math.min(h, 24 * 30) * 3600e3 : null;
}
function canBatch(u, bid) { const ids = L.batchIds(u); return u.role !== 'doctor' && (!ids || ids.includes(Number(bid))); }
function sanitizeLecture(l, u) {
  const d = L.decorate(l);
  if (u.role === 'doctor') { delete d.batch_code; delete d.batch_year; delete d.university; delete d.coordinator; delete d.batch_id; delete d.coordinator_id; delete d.lec_file; delete d.src_q_file; delete d.video_file; delete d.q_file; delete d.priority; delete d.excuse_note; delete d.ok_by_name; delete d.uploaded_by_name; }
  return d;
}

/* ---------------- routes ---------------- */
const routes = [];
const route = (method, pattern, fn, opts = {}) => routes.push({ method, pattern, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, ...opts });

route('POST', '/api/login', async ({ body, res }) => {
  const u = one('SELECT * FROM users WHERE lower(email)=lower(?) AND active=1', str(body.email) || '');
  if (!u || !A.verify(body.pass || '', u.pass)) fail(401, 'الإيميل أو كلمة المرور غلط');
  res.setHeader('Set-Cookie', A.makeCookie(u.id)); audit(u.id, 'login');
  return { ok: true };
}, { public: true, noAudit: true });
route('POST', '/api/forgot', async ({ body }) => {
  const u = one('SELECT id, name, tg_id FROM users WHERE lower(email)=lower(?) AND active=1', str(body.email, 200) || '');
  const msg = { ok: true, message: 'لو الإيميل ده متسجل وحسابه مربوط بالبوت، الكود وصله على تليجرام. لو حسابك مش مربوط بالبوت كلّم الأدمن يعملك كلمة سر جديدة.' };
  if (!u || !u.tg_id) return msg;
  const old = one('SELECT sent_at FROM reset_codes WHERE user_id=?', u.id); if (old && Date.now() - old.sent_at < 60e3) return msg;
  const code = String(require('node:crypto').randomInt(0, 1e6)).padStart(6, '0');
  run('INSERT INTO reset_codes(user_id,code,exp,tries,sent_at) VALUES(?,?,?,0,?) ON CONFLICT(user_id) DO UPDATE SET code=excluded.code, exp=excluded.exp, tries=0, sent_at=excluded.sent_at', u.id, A.hash(code), Date.now() + 15 * 60e3, Date.now());
  await bot.send(u.tg_id, `🔐 كود تغيير كلمة السر: ${code}\nصالح 15 دقيقة.\nلو مش انت اللي طلبته، تجاهل الرسالة دي.`); audit(u.id, 'reset_request');
  return msg;
}, { public: true, noAudit: true });
route('POST', '/api/forgot/reset', async ({ body }) => {
  const u = one('SELECT id FROM users WHERE lower(email)=lower(?) AND active=1', str(body.email, 200) || ''), bad = () => fail(400, 'الكود غلط أو خلص، اطلب كود جديد');
  const rc = u && one('SELECT * FROM reset_codes WHERE user_id=?', u.id); if (!rc || rc.exp < Date.now() || rc.tries >= 5) bad();
  if (!A.verify(String(body.code || '').trim(), rc.code)) { run('UPDATE reset_codes SET tries=tries+1 WHERE user_id=?', u.id); bad(); }
  const pass = String(body.pass || ''); if (pass.length < 8) fail(400, 'كلمة السر لازم 8 حروف على الأقل');
  run('UPDATE users SET pass=? WHERE id=?', A.hash(pass), u.id); run('DELETE FROM reset_codes WHERE user_id=?', u.id); audit(u.id, 'password_reset');
  return { ok: true };
}, { public: true, noAudit: true });
route('POST', '/api/logout', async ({ res }) => { res.setHeader('Set-Cookie', [A.clearCookie(), A.clearImp()]); return { ok: true }; }, { public: true, noAudit: true });
route('POST', '/api/impersonate/:id', async ({ u, p, res, req }) => {
  const realAdmin = u.role === 'admin' ? u : A.impFromReq(req); if (!realAdmin) fail(403, 'الأدمن بس');
  const t = one('SELECT id, name, role, active FROM users WHERE id=?', int(p.id)) || fail(404, 'مش موجود');
  if (!t.active) fail(400, 'الحساب ده مقفول'); if (t.role === 'admin') fail(400, 'مينفعش تدخل على حساب أدمن');
  res.setHeader('Set-Cookie', [A.makeCookie(t.id), A.impCookie(realAdmin.id)]); audit(realAdmin.id, 'impersonate', { as: t.id });
  return { ok: true };
}, { noAudit: true });
route('POST', '/api/impersonate-stop', async ({ res, req }) => {
  const a = A.impFromReq(req) || fail(400, 'إنت مش داخل على حساب حد');
  res.setHeader('Set-Cookie', [A.makeCookie(a.id), A.clearImp()]); return { ok: true };
});
route('GET', '/api/me', async ({ u, req }) => {
  const x = one('SELECT id,name,email,role,tg_id,link_code,tg_username,whatsapp FROM users WHERE id=?', u.id);
  const imp = x.role !== 'admin' ? A.impFromReq(req) : null;
  return { ...x, impersonated_by: imp ? imp.name : null, linked: !!x.tg_id, brand: setting('brand'), types: L.TYPES, daily: L.DAILY, weekly: L.WEEKLY,
    settings: { deadline_hours: setting('deadline_hours'), upload_minutes: setting('upload_minutes'), coord_reply_minutes: setting('coord_reply_minutes'), cs_reply_minutes: setting('cs_reply_minutes'), sup_grace_minutes: setting('sup_grace_minutes') }, kinds: L.KINDS, today: L.dayStr(), week: L.weekStr() };
});
route('POST', '/api/me/password', async ({ u, body }) => {
  const x = one('SELECT pass FROM users WHERE id=?', u.id);
  if (!A.verify(body.old || '', x.pass)) fail(400, 'كلمة المرور الحالية غلط');
  if (!body.new || String(body.new).length < 8) fail(400, 'كلمة المرور الجديدة لازم 8 حروف على الأقل');
  run('UPDATE users SET pass=? WHERE id=?', A.hash(body.new), u.id); return { ok: true };
});

/* payout methods */
const PAYOUT = { vodafone: 'فودافون كاش', instapay: 'إنستاباي', bank: 'حساب بنكي' };
const ROLE_AR = { admin: 'أدمن', supervisor: 'مشرف', coordinator: 'مسؤول دفعة', cs: 'خدمة عملاء', doctor: 'دكتور' };
function notifyChange(u, what) { audit(u.id, 'profile_change', { what }); const x = one('SELECT name, role FROM users WHERE id=?', u.id); if (x.role !== 'admin') bot.sendAdmin(`تنبيه: ${x.name} (${ROLE_AR[x.role]}) ${what}.\nراجعها من الحسابات.`).catch(() => {}); }
route('GET', '/api/me/payout', async ({ u }) => all('SELECT * FROM payout_methods WHERE user_id=? ORDER BY id', u.id));
route('PUT', '/api/me/contact', async ({ u, body }) => {
  const tgu = (str(body.tg_username, 64) || '').replace(/^@/, '').replace(/[^\w]/g, '') || null, wa = (str(body.whatsapp, 30) || '').replace(/[^\d+]/g, '') || null;
  const old = one('SELECT tg_username, whatsapp FROM users WHERE id=?', u.id);
  run('UPDATE users SET tg_username=?, whatsapp=? WHERE id=?', tgu, wa, u.id);
  if (old.tg_username !== tgu || old.whatsapp !== wa) notifyChange(u, `غيّر بيانات التواصل (تليجرام: ${tgu ? '@' + tgu : '—'} · واتساب: ${wa || '—'})`);
  return { ok: true };
}, { noAudit: true });
route('GET', '/api/me/transfers', async ({ u }) => all('SELECT id, note, file_name, mime, created_at, needs_confirm, confirmed_at, problem, problem_at, settlement_id, (file_path IS NOT NULL) has_file FROM transfer_msgs WHERE user_id=? ORDER BY created_at DESC LIMIT 30', u.id));
route('POST', '/api/me/transfers/:id/confirm', async ({ u, p }) => {
  const t = one('SELECT * FROM transfer_msgs WHERE id=? AND user_id=?', int(p.id), u.id) || fail(404, 'مش موجود');
  if (!t.confirmed_at) await bot.confirmTransfer(t, u); return { ok: true };
}, { noAudit: true });
route('POST', '/api/me/transfers/:id/problem', async ({ u, p, body }) => {
  const t = one('SELECT * FROM transfer_msgs WHERE id=? AND user_id=?', int(p.id), u.id) || fail(404, 'مش موجود');
  await bot.recordTransferProblem(t, u, req1(str(body.text, 1000), 'المشكلة'), null); return { ok: true };
}, { noAudit: true });
route('GET', '/api/transfers/:id/file', async ({ u, p, res }) => {
  const t = one('SELECT * FROM transfer_msgs WHERE id=?', int(p.id)) || fail(404, 'مش موجود');
  if (u.role !== 'admin' && t.user_id !== u.id) fail(403, 'مش مسموح'); if (!t.file_path || !fs.existsSync(t.file_path)) fail(404, 'مفيش ملف');
  res.writeHead(200, { 'content-type': t.mime || 'application/octet-stream', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' }); fs.createReadStream(t.file_path).pipe(res);
});
route('POST', '/api/finance/:id/message', async ({ u, body, files, p }) => {
  need(u, 'admin'); const id = int(p.id), target = one('SELECT id, name, tg_id FROM users WHERE id=?', id) || fail(404, 'مش موجود');
  const note = str(body.note, 2000), f = files.receipt; if (!note && !f) fail(400, 'اكتب ملاحظة أو ارفع الإيصال');
  const confirm = body.confirm === undefined ? !!f : ['1', 'true', 'on', true, 1].includes(body.confirm), sid = int(body.settlement_id);
  const st = sid ? one('SELECT * FROM settlements WHERE id=? AND user_id=?', sid, id) || fail(400, 'التقفيل ده مش بتاعه') : null;
  let fp = null; if (f) { fp = path.join(ATT, `tr-${id}-${Date.now()}-${f.name.replace(/[^\w.\-]+/g, '_').slice(-50)}`); fs.writeFileSync(fp, f.buf); }
  const r = run('INSERT INTO transfer_msgs(user_id,note,file_path,file_name,mime,by,created_at,needs_confirm,settlement_id) VALUES(?,?,?,?,?,?,?,?,?)', id, note, fp, f ? f.name : null, f ? f.mime : null, u.id, Date.now(), confirm ? 1 : 0, st ? st.id : null);
  const tid = Number(r.lastInsertRowid);
  let ok = false;
  if (target.tg_id) {
    if (st) await bot.sendFile('sendDocument', 'document', target.tg_id, statementPdf(st.id), `كشف-حساب-${st.period}.pdf`, `كشف حساب ${st.period}`, 'application/pdf');
    const cap = `رسالة من الحسابات${note ? `\n\n${note}` : ''}${confirm ? '\n\nلما يوصلك التحويل دوس "استلمت ✓"، ولو فيه مشكلة دوس "فيه مشكلة".' : ''}`;
    const kb = confirm ? bot.transferKb(tid) : undefined;
    if (f) ok = !!(await bot.sendFile((f.mime || '').startsWith('image/') ? 'sendPhoto' : 'sendDocument', (f.mime || '').startsWith('image/') ? 'photo' : 'document', target.tg_id, f.buf, f.name, cap, f.mime, null, kb));
    else ok = !!(await bot.send(target.tg_id, cap, kb ? { reply_markup: kb } : {}));
  }
  run('UPDATE transfer_msgs SET delivered=? WHERE id=?', ok ? 1 : 0, tid);
  return { ok: true, delivered: ok };
});
route('POST', '/api/me/payout', async ({ u, body }) => {
  const kind = body.kind in PAYOUT ? body.kind : fail(400, 'اختار طريقة التحويل');
  const name = req1(str(body.name, 120), 'الاسم');
  if (kind === 'bank') { req1(str(body.bank, 120), 'اسم البنك'); if (!str(body.iban, 60) && !str(body.account, 60)) fail(400, 'اكتب الأيبان أو رقم الحساب'); }
  else req1(str(body.number, 60), 'الرقم');
  run('INSERT INTO payout_methods(user_id,kind,name,number,bank,iban,account,created_at) VALUES(?,?,?,?,?,?,?,?)', u.id, kind, name, str(body.number, 60), str(body.bank, 120), str(body.iban, 60), str(body.account, 60), Date.now());
  notifyChange(u, `ضاف طريقة تحويل جديدة (${PAYOUT[kind]})`);
  return { ok: true };
}, { noAudit: true });
route('DELETE', '/api/me/payout/:id', async ({ u, p }) => { const x = one('SELECT kind FROM payout_methods WHERE id=? AND user_id=?', int(p.id), u.id); if (x) { run('DELETE FROM payout_methods WHERE id=?', int(p.id)); notifyChange(u, `مسح طريقة تحويل (${PAYOUT[x.kind]})`); } return { ok: true }; }, { noAudit: true });

/* home */
route('GET', '/api/home', async ({ u }) => {
  const out = { summary: u.role === 'doctor' ? null : L.daySummary(u), alerts: L.alerts(u).slice(0, 60) };
  if (u.role !== 'doctor') out.batches = L.batchRows(u);
  if (u.role === 'doctor') out.stats = L.doctorStats(u.id);
  if (u.role === 'coordinator') out.mine = L.coordinatorStats(u.id);
  if (u.role === 'supervisor') out.mine = L.supervisorStats(u.id);
  if (u.role === 'cs') out.mine = L.csStats(u.id);
  if (u.role === 'admin' || u.role === 'supervisor') {
    const days = []; const t0 = L.dayStart();
    const ls = L.scopedLectures(u, 'AND sent_at>=?', t0 - 13 * L.DAY);
    for (let i = 13; i >= 0; i--) { const a = t0 - i * L.DAY, b = a + L.DAY, d = ls.filter(l => l.sent_at >= a && l.sent_at < b);
      days.push({ day: L.dayStr(a + L.H * 12), sent: d.length, late: d.filter(l => L.isLate(l.video_at, l.sent_at, l.excused) || L.isLate(l.q_at, l.sent_at, l.excused)).length, ontime: d.filter(l => L.delivered(l) && !L.isLate(l.video_at, l.sent_at, l.excused) && !L.isLate(l.q_at, l.sent_at, l.excused)).length }); }
    out.days = days;
  }
  return out;
});

/* universities & batches */
route('GET', '/api/universities', async ({ u }) => { need(u, 'admin', 'supervisor', 'coordinator', 'cs'); return all('SELECT * FROM universities ORDER BY code'); });
route('POST', '/api/universities', async ({ u, body }) => { need(u, 'admin'); const r = run('INSERT INTO universities(code,name) VALUES(?,?)', req1(str(body.code, 20), 'الكود'), req1(str(body.name, 100), 'الاسم')); return { id: Number(r.lastInsertRowid) }; });
route('PATCH', '/api/universities/:id', async ({ u, body, p }) => { need(u, 'admin'); run('UPDATE universities SET code=COALESCE(?,code), name=COALESCE(?,name) WHERE id=?', str(body.code, 20), str(body.name, 100), int(p.id)); return { ok: true }; });
route('GET', '/api/batches', async ({ u }) => { need(u, 'admin', 'supervisor', 'coordinator', 'cs'); return L.batchRows(u); });
route('POST', '/api/batches', async ({ u, body }) => {
  need(u, 'admin');
  const uni = one('SELECT * FROM universities WHERE id=?', req1(int(body.university_id), 'الجامعة')) || fail(400, 'الجامعة مش موجودة');
  const year = req1(str(body.year, 40), 'السنة'), code = str(body.code, 20) || `${uni.code}-${str(body.year_no, 5) || year}`;
  const r = run('INSERT INTO batches(university_id,year,code,supervisor_id,coordinator_id,expected_subs) VALUES(?,?,?,?,?,?)', uni.id, year, code, int(body.supervisor_id), int(body.coordinator_id), int(body.expected_subs) || 0);
  return { id: Number(r.lastInsertRowid) };
});
route('PATCH', '/api/batches/:id', async ({ u, body, p }) => {
  const id = int(p.id); if (!canBatch(u, id) || u.role === 'cs') fail(403, 'مش مسموح');
  if ('exam_date' in body) run('UPDATE batches SET exam_date=?, exam_note=? WHERE id=?', str(body.exam_date, 10) || null, str(body.exam_note, 200), id);
  if (u.role === 'admin') {
    for (const [k, f] of [['year', v => str(v, 40)], ['code', v => str(v, 20)], ['supervisor_id', int], ['coordinator_id', int], ['expected_subs', int], ['active', int]])
      if (k in body) run(`UPDATE batches SET ${k}=? WHERE id=?`, f(body[k]), id);
  }
  return { ok: true };
});

/* doctors */
function doctorRow(id, u) {
  const d = one('SELECT u.id,u.name,u.email,u.phone,u.tg_id,u.link_code,u.active,doc.* FROM users u JOIN doctors doc ON doc.user_id=u.id WHERE u.id=?', id);
  if (!d) return null;
  const st = L.doctorStats(id); const r = { ...d, linked: !!d.tg_id, stats: st };
  delete r.tg_id; if (u.role !== 'admin') { delete r.link_code; delete r.adj; }
  if (!['admin', 'coordinator', 'supervisor'].includes(u.role)) { delete r.price_theory; delete r.price_practical; delete r.price_revision; }
  return r;
}
route('GET', '/api/doctors', async ({ u }) => {
  need(u, 'admin', 'supervisor', 'coordinator', 'cs');
  const ids = u.role === 'admin' || u.role === 'coordinator' || u.role === 'cs' ? all("SELECT id FROM users WHERE role='doctor' AND active=1").map(r => r.id) : L.scopedDoctorIds(u);
  return ids.map(id => doctorRow(id, u)).filter(Boolean);
});
route('GET', '/api/doctors/:id', async ({ u, p }) => {
  const id = int(p.id); if (u.role === 'doctor' && u.id !== id) fail(403, 'مش مسموح');
  const d = doctorRow(id, u) || fail(404, 'مش موجود');
  d.lectures = L.scopedLectures(u, 'AND doctor_id=? ORDER BY sent_at DESC LIMIT 40', id).map(l => sanitizeLecture(l, u));
  d.penalties = all('SELECT * FROM penalties WHERE user_id=? ORDER BY created_at DESC', id);
  if (NOTE_ROLES.includes(u.role)) d.notes = doctorNotes(id, u);
  return d;
});
const NOTE_ROLES = ['admin', 'supervisor', 'coordinator'];
const doctorNotes = (id, u) => all('SELECT n.id, n.body, n.created_at, n.by, w.name author, w.role author_role FROM doctor_notes n LEFT JOIN users w ON w.id=n.by WHERE n.doctor_id=? ORDER BY n.created_at DESC', id).map(n => ({ ...n, mine: n.by === u.id || u.role === 'admin' }));
route('POST', '/api/doctors/:id/notes', async ({ u, p, body }) => {
  need(u, ...NOTE_ROLES); const id = int(p.id); one("SELECT 1 FROM users WHERE id=? AND role='doctor'", id) || fail(404, 'مش موجود');
  run('INSERT INTO doctor_notes(doctor_id,by,body,created_at) VALUES(?,?,?,?)', id, u.id, req1(str(body.body, 2000), 'الملاحظة'), Date.now());
  return doctorNotes(id, u);
});
route('DELETE', '/api/notes/:id', async ({ u, p }) => {
  need(u, ...NOTE_ROLES); const n = one('SELECT * FROM doctor_notes WHERE id=?', int(p.id)) || fail(404, 'مش موجودة');
  if (n.by !== u.id && u.role !== 'admin') fail(403, 'تقدر تمسح ملاحظاتك بس'); run('DELETE FROM doctor_notes WHERE id=?', n.id); return { ok: true };
});
route('PATCH', '/api/doctors/:id', async ({ u, body, p }) => {
  need(u, 'admin'); const id = int(p.id);
  for (const k of ['price_theory', 'price_practical', 'price_revision', 'capacity', 'adj']) if (k in body) run(`UPDATE doctors SET ${k}=? WHERE user_id=?`, real(body[k]) ?? 0, id);
  return { ok: true };
});

route('POST', '/api/doctors/:id/queue', async ({ u, body, p }) => {
  need(u, 'admin', 'supervisor'); const did = int(p.id), ids = (Array.isArray(body.order) ? body.order : []).map(Number);
  tx(() => ids.forEach((lid, i) => { const l = one('SELECT batch_id FROM lectures WHERE id=? AND doctor_id=?', lid, did); if (l && canBatch(u, l.batch_id)) run('UPDATE lectures SET queue_pos=? WHERE id=?', i + 1, lid); }));
  return { ok: true };
});
route('GET', '/api/myrank', async ({ u }) => {
  if (u.role === 'admin') return { rank: null };
  const m = L.dayStr().slice(0, 7), list = rankings(m)[u.role] || [], me = list.find(x => x.id === u.id);
  return { month: m, rank: me ? me.rank : null, of: list.length };
});

/* lectures */
route('GET', '/api/lectures', async ({ u, q }) => {
  let ls = L.scopedLectures(u, 'ORDER BY sent_at DESC LIMIT 1500');
  if (q.batch) ls = ls.filter(l => l.batch_id === int(q.batch));
  if (q.doctor) ls = ls.filter(l => l.doctor_id === int(q.doctor));
  if (q.type) ls = ls.filter(l => l.type === q.type);
  if (q.priority !== undefined && q.priority !== '' && u.role !== 'doctor') ls = ls.filter(l => l.priority === int(q.priority));
  if (q.sort === 'priority' && u.role !== 'doctor') ls.sort((a, b) => b.priority - a.priority || a.sent_at - b.sent_at);
  if (u.role === 'doctor' || q.sort === 'queue') ls.sort((a, b) => (L.delivered(a) - L.delivered(b)) || ((a.queue_pos ?? 1e9) - (b.queue_pos ?? 1e9)) || (b.sent_at - a.sent_at));
  let out = ls.map(l => sanitizeLecture(l, u));
  if (q.state) out = out.filter(l => l.state === q.state);
  if (q.q) { const s = String(q.q).toLowerCase(); out = out.filter(l => `${l.id} ${l.name} ${l.batch_code || ''} ${l.doctor}`.toLowerCase().includes(s)); }
  return out.slice(0, int(q.limit) || 300);
});
route('GET', '/api/lectures/:id', async ({ u, p }) => {
  const l = one('SELECT * FROM lectures WHERE id=?', int(p.id)) || fail(404, 'مش موجودة');
  if (u.role === 'doctor' ? l.doctor_id !== u.id : !canBatch(u, l.batch_id)) fail(403, 'مش مسموح');
  const d = sanitizeLecture(l, u); if (u.role !== 'doctor') d.price_log = all('SELECT pl.*, us.name by_name FROM price_log pl LEFT JOIN users us ON us.id=pl.by WHERE lecture_id=? ORDER BY at', l.id);
  return d;
});
route('POST', '/api/lectures', async ({ u, body, files }) => {
  need(u, 'admin', 'coordinator');
  const bid = req1(int(body.batch_id), 'الدفعة'); if (!canBatch(u, bid)) fail(403, 'الدفعة دي مش بتاعتك');
  const did = req1(int(body.doctor_id), 'الدكتور'); const doc = one("SELECT u.*, d.* FROM users u JOIN doctors d ON d.user_id=u.id WHERE u.id=? AND u.active=1", did) || fail(400, 'الدكتور مش موجود');
  const type = body.type in L.TYPES ? body.type : fail(400, 'النوع غلط');
  const kind = body.kind in L.KINDS ? body.kind : 'new';
  const name = req1(str(body.name, 200), 'اسم المحاضرة');
  const price = kind === 'repeat' ? (real(body.price) ?? fail(400, 'اكتب سعر المحاضرة المعادة بإيدك')) : (real(body.price) ?? doc[`price_${type}`]);
  const coord = u.role === 'coordinator' ? u.id : (one('SELECT coordinator_id FROM batches WHERE id=?', bid) || {}).coordinator_id || u.id;
  const noq = body.no_q === true || body.no_q === '1' || body.no_q === 'on', t0 = Date.now(), pr = Math.max(0, Math.min(3, int(body.priority) ?? 1));
  const r = run('INSERT INTO lectures(batch_id,doctor_id,coordinator_id,type,kind,name,price,sent_at,no_q,q_at,q_ok_at,priority) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', bid, did, coord, type, kind, name, price, t0, noq ? 1 : 0, noq ? t0 : null, noq ? t0 : null, pr);
  const l = one('SELECT * FROM lectures WHERE id=?', Number(r.lastInsertRowid));
  const fl = [];
  if (files.lec) fl.push({ ...files.lec, field: 'lec_file', label: 'ملف المحاضرة' });
  if (files.qsrc) fl.push({ ...files.qsrc, field: 'src_q_file', label: 'مرجع ملف الأسئلة' });
  const sent = await bot.sendLecture(l, fl);
  const today = all('SELECT COUNT(*) n FROM lectures WHERE doctor_id=? AND sent_at>=?', did, L.dayStart())[0].n;
  return { id: l.id, delivered_to_bot: sent, over_capacity: today > doc.capacity, today, capacity: doc.capacity };
});
route('PATCH', '/api/lectures/:id', async ({ u, body, p }) => {
  const l = one('SELECT * FROM lectures WHERE id=?', int(p.id)) || fail(404, 'مش موجودة');
  const supOk = ['priority', 'excuse', 'unexcuse', 'approve', 'uploaded', 'forward', 'exempt_q', 'rate'].includes(body.action);
  if (!canBatch(u, l.batch_id) || !(['admin', 'coordinator'].includes(u.role) || (supOk && u.role === 'supervisor'))) fail(403, 'مش مسموح');
  if ((body.action === 'excuse' || body.action === 'unexcuse') && !['admin', 'supervisor'].includes(u.role)) fail(403, 'استثناء التأخير للمشرف والأدمن بس');
  const t = Date.now();
  switch (body.action) {
    case 'approve':
      if (body.video && l.video_at && !l.video_ok_at) run('UPDATE lectures SET video_ok_at=?, ok_by=? WHERE id=?', t, u.id, l.id);
      if (body.q && l.q_at && !l.q_ok_at) run('UPDATE lectures SET q_ok_at=?, ok_by=? WHERE id=?', t, u.id, l.id);
      break;
    case 'rate': {
      const c = (v, m) => Math.max(0, Math.min(m, Number(v) || 0));
      run('UPDATE lectures SET r_video=?, r_q=?, r_instr=?, r_comm=? WHERE id=?', c(body.r_video, 40), c(body.r_q, 10), c(body.r_instr, 10), c(body.r_comm, 5), l.id); break; }
    case 'uploaded': if (!(l.video_ok_at && l.q_ok_at)) fail(400, 'لازم الفيديو والأسئلة يتعتمدوا الأول'); run('UPDATE lectures SET uploaded_at=?, uploaded_by=? WHERE id=?', t, u.id, l.id); break;
    case 'price': {
      if (l.settlement_id) fail(400, 'المحاضرة دي اتحاسبت خلاص');
      const np = real(body.price); if (np == null || np < 0) fail(400, 'السعر غلط');
      run('INSERT INTO price_log(lecture_id,old,new,by,at) VALUES(?,?,?,?,?)', l.id, l.price, np, u.id, t);
      run('UPDATE lectures SET price=? WHERE id=?', np, l.id); await bot.notifyPriceChange({ ...l, price: np }, l.price); break; }
    case 'forward': {
      const me = one('SELECT tg_id FROM users WHERE id=?', u.id);
      if (!me.tg_id) fail(400, 'اربط حسابك بالبوت الأول من صفحة حسابي');
      if (l.video_file) await bot.forwardFile(me.tg_id, l.video_file, 'video', `#${l.id} ${l.name} · فيديو`);
      if (l.q_file) await bot.forwardFile(me.tg_id, l.q_file, 'doc', `#${l.id} ${l.name} · ملف الأسئلة`);
      break; }
    case 'priority': run('UPDATE lectures SET priority=? WHERE id=?', Math.max(0, Math.min(3, int(body.priority) ?? 1)), l.id); break;
    case 'excuse': run('UPDATE lectures SET excused=1, excuse_note=? WHERE id=?', str(body.note, 300), l.id); break;
    case 'unexcuse': run('UPDATE lectures SET excused=0, excuse_note=NULL WHERE id=?', l.id); break;
    case 'exempt_q': if (l.q_at && !l.no_q) fail(400, 'ملف الأسئلة اتسلم خلاص'); run('UPDATE lectures SET no_q=1, q_at=sent_at, q_ok_at=?, q_file=NULL WHERE id=?', t, l.id); break;
    case 'unexempt_q': if (!l.no_q) fail(400, 'المحاضرة مش معفية'); if (l.settlement_id) fail(400, 'المحاضرة اتحاسبت'); run('UPDATE lectures SET no_q=0, q_at=NULL, q_ok_at=NULL WHERE id=?', l.id); break;
    case 'cancel': if (u.role !== 'admin') fail(403, 'الأدمن بس'); if (l.settlement_id) fail(400, 'المحاضرة دي دخلت في حساب اتقفل، مينفعش تتمسح'); run('UPDATE tickets SET lecture_id=NULL WHERE lecture_id=?', l.id); run('DELETE FROM price_log WHERE lecture_id=?', l.id); run('DELETE FROM lectures WHERE id=?', l.id); break;
    default: fail(400, 'إجراء غير معروف');
  }
  return { ok: true };
});

/* tickets */
route('GET', '/api/tickets', async ({ u, q }) => {
  if (u.role === 'doctor') fail(403, 'مش مسموح');
  const ids = L.batchIds(u);
  let ts = all(`SELECT t.*, b.code batch_code, d.name doctor, l.name lecture, c.name created_by_name FROM tickets t JOIN batches b ON b.id=t.batch_id LEFT JOIN users d ON d.id=t.doctor_id LEFT JOIN lectures l ON l.id=t.lecture_id LEFT JOIN users c ON c.id=t.created_by
    WHERE ${ids ? `t.batch_id IN (${L.inList(ids)})` : '1=1'} ${q.open === '1' ? 'AND t.closed_at IS NULL' : ''} ORDER BY t.closed_at IS NOT NULL, t.created_at DESC LIMIT 400`);
  const lim = Number(setting('coord_reply_minutes')) * 60e3, cl = Number(setting('cs_reply_minutes')) * 60e3, n = Date.now();
  const g = L.supGrace(), nm = Object.fromEntries(all('SELECT id, name, role FROM users').map(x => [x.id, x]));
  ts.sort((a, b) => (!!a.closed_at - !!b.closed_at) || (a.closed_at ? b.created_at - a.created_at : (b.priority - a.priority) || ((a.due_at || 9e15) - (b.due_at || 9e15)) || b.created_at - a.created_at));
  return ts.map(({ att_path, reply_path, ...t }) => ({ ...t, has_att: !!(att_path || t.att_file_id), has_reply_file: !!(reply_path || t.reply_file_id), holder: L.ticketHolder(t), due_late: !!(t.due_at && !t.closed_at && n > t.due_at),
    by: { sent: nm[t.sent_by], returned: nm[t.returned_by], closed: nm[t.closed_by] }, both_late: L.returnLate(t, g), stage: t.closed_at ? 'closed' : t.kind === 'problem' ? 'problem' : !t.sent_doctor_at ? 'new' : !t.reply_at ? 'doctor' : !t.returned_at ? 'return' : 'deliver',
    coord_late: !!(t.reply_at && (t.returned_at || n) - t.reply_at > lim), cs_late: !!(t.returned_at && (t.delivered_at || n) - t.returned_at > cl) }));
});
route('POST', '/api/tickets', async ({ u, body, files }) => {
  need(u, 'admin', 'cs', 'coordinator');
  const bid = req1(int(body.batch_id), 'الدفعة'); if (!canBatch(u, bid)) fail(403, 'مش مسموح');
  const kind = body.kind === 'problem' ? 'problem' : 'question';
  const lid = int(body.lecture_id); const lec = lid ? one('SELECT * FROM lectures WHERE id=? AND batch_id=?', lid, bid) : null;
  // general question: straight to a doctor, no lecture
  const gdoc = !lec && kind === 'question' && int(body.doctor_id) ? one("SELECT id, name FROM users WHERE id=? AND role='doctor' AND active=1", int(body.doctor_id)) || fail(400, 'الدكتور مش موجود') : null;
  const att = files.att; const text = str(body.body) || (att ? (/^audio|ogg|opus/.test(att.mime || '') ? '[سؤال صوتي]' : '[سؤال مرفق]') : null);
  const n0 = Date.now();
  const r = run('INSERT INTO tickets(kind,batch_id,lecture_id,doctor_id,body,student,created_by,created_at,priority,due_at,direct,sent_doctor_at,sent_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', kind, bid, lec ? lec.id : null, lec ? lec.doctor_id : gdoc ? gdoc.id : null,
    req1(text, 'النص أو الريكورد'), str(body.student, 200), u.id, n0, PRI(body.priority), dueFrom(body), gdoc ? 1 : 0, gdoc ? n0 : null, gdoc ? u.id : null);
  const id = Number(r.lastInsertRowid);
  if (att) { const f = path.join(ATT, `${id}-${att.name.replace(/[^\w.\-]+/g, '_').slice(-60)}`); fs.writeFileSync(f, att.buf); run('UPDATE tickets SET att_path=?, att_name=?, att_mime=? WHERE id=?', f, att.name, att.mime || 'application/octet-stream', id); }
  let delivered = null;
  if (gdoc) { delivered = await bot.sendTicket(one('SELECT * FROM tickets WHERE id=?', id)); setImmediate(() => bot.notifyCoordDirect(one('SELECT * FROM tickets WHERE id=?', id)).catch(e => console.error(e))); }
  else setImmediate(() => bot.notifyCoordNew(one('SELECT * FROM tickets WHERE id=?', id)).catch(e => console.error(e)));
  return { id, direct: !!gdoc, delivered_to_bot: delivered };
});
route('PATCH', '/api/tickets/:id', async ({ u, body, p }) => {
  const t = one('SELECT * FROM tickets WHERE id=?', int(p.id)) || fail(404, 'مش موجودة');
  if (!canBatch(u, t.batch_id)) fail(403, 'مش مسموح');
  const n = Date.now(), coordOk = ['admin', 'coordinator', 'supervisor'].includes(u.role), csOk = ['admin', 'cs'].includes(u.role);
  switch (body.action) {
    case 'send_doctor': {
      if (!coordOk) fail(403, 'مش مسموح');
      const did = int(body.doctor_id) || t.doctor_id; if (!did) fail(400, 'اختار الدكتور');
      run('UPDATE tickets SET doctor_id=?, lecture_id=COALESCE(?,lecture_id), sent_doctor_at=?, sent_by=? WHERE id=?', did, int(body.lecture_id), n, u.id, t.id);
      const ok = await bot.sendTicket(one('SELECT * FROM tickets WHERE id=?', t.id));
      return { ok: true, delivered_to_bot: ok }; }
    case 'set_reply': if (!coordOk) fail(403, 'مش مسموح'); run('UPDATE tickets SET reply=?, reply_at=COALESCE(reply_at,?) WHERE id=?', req1(str(body.reply), 'الرد'), n, t.id); break;
    case 'return': if (!coordOk || !t.reply_at) fail(400, 'لسه الدكتور مارد'); run('UPDATE tickets SET returned_at=?, returned_by=? WHERE id=? AND returned_at IS NULL', n, u.id, t.id); if (!t.returned_at) await bot.notifyCsReturn(one('SELECT * FROM tickets WHERE id=?', t.id)); break;
    case 'deliver': if (!csOk || !t.returned_at) fail(400, 'الرد لسه مارجعش'); run('UPDATE tickets SET delivered_at=?, delivered_by=?, closed_at=? WHERE id=?', n, u.id, n, t.id); break;
    case 'delete': need(u, 'admin'); for (const f of [t.att_path, t.reply_path]) if (f) fs.rmSync(f, { force: true }); run('DELETE FROM tickets WHERE id=?', t.id); break;
    case 'priority': if (!(coordOk || csOk)) fail(403, 'مش مسموح'); run('UPDATE tickets SET priority=? WHERE id=?', PRI(body.priority), t.id); break;
    case 'due': if (!(coordOk || csOk)) fail(403, 'مش مسموح'); run('UPDATE tickets SET due_at=? WHERE id=?', dueFrom(body), t.id); break;
    case 'forward': {
      const me = one('SELECT tg_id FROM users WHERE id=?', u.id); if (!me.tg_id) fail(400, 'اربط حسابك بالبوت الأول من صفحة حسابي');
      if (t.reply_file_id) await bot.call({ voice: 'sendVoice', audio: 'sendAudio', photo: 'sendPhoto', video: 'sendVideo', video_note: 'sendVideoNote' }[t.reply_kind] || 'sendDocument', { chat_id: me.tg_id, [t.reply_kind === 'voice' ? 'voice' : t.reply_kind === 'audio' ? 'audio' : t.reply_kind === 'photo' ? 'photo' : t.reply_kind === 'video' ? 'video' : t.reply_kind === 'video_note' ? 'video_note' : 'document']: t.reply_file_id, ...(t.reply_kind === 'video_note' ? {} : { caption: `رد الدكتور على السؤال #${t.id}` }) });
      else fail(400, 'الرد مفيهوش ملف');
      break; }
    case 'close': if (t.kind !== 'problem' || !(coordOk || csOk)) fail(400, 'مش مسموح'); run('UPDATE tickets SET resolution=?, closed_at=?, closed_by=? WHERE id=?', str(body.resolution), n, u.id, t.id); break;
    default: fail(400, 'إجراء غير معروف');
  }
  return { ok: true };
});

route('GET', '/api/my-questions', async ({ u }) => {
  need(u, 'doctor');
  return all("SELECT t.id, t.kind, t.body, t.priority, t.due_at, t.sent_doctor_at, t.reply, t.reply_at, t.reply_kind, t.att_kind, t.att_mime, t.closed_at, (t.att_path IS NOT NULL OR t.att_file_id IS NOT NULL) has_att, (t.reply_path IS NOT NULL OR t.reply_file_id IS NOT NULL) has_reply_file, l.name lecture FROM tickets t LEFT JOIN lectures l ON l.id=t.lecture_id WHERE t.doctor_id=? AND t.sent_doctor_at IS NOT NULL ORDER BY t.reply_at IS NOT NULL, t.priority DESC, t.sent_doctor_at DESC LIMIT 200", u.id)
    .map(t => ({ ...t, urgent: t.priority >= 2, priority: undefined }));
});
route('POST', '/api/my-questions/:id/reply', async ({ u, p, body, files }) => {
  need(u, 'doctor'); const t = one('SELECT * FROM tickets WHERE id=? AND doctor_id=? AND sent_doctor_at IS NOT NULL', int(p.id), u.id) || fail(404, 'مش موجود');
  if (t.reply_at) fail(400, 'انت رديت على السؤال ده خلاص');
  const f = files.file || files.reply, text = str(body.reply, 4000) || (f ? (/^audio|ogg|opus|webm/.test(f.mime || '') ? '[رد صوتي]' : '[رد مرفق]') : null);
  req1(text, 'الرد أو الريكورد'); let fp = null;
  if (f) { fp = path.join(ATT, `r${t.id}-${f.name.replace(/[^\w.\-]+/g, '_').slice(-60)}`); fs.writeFileSync(fp, f.buf); }
  run('UPDATE tickets SET reply=?, reply_at=?, reply_path=?, reply_mime=?, reply_name=? WHERE id=?', text, Date.now(), fp, f ? f.mime || 'application/octet-stream' : null, f ? f.name : null, t.id);
  await bot.notifyCoordReply(one('SELECT * FROM tickets WHERE id=?', t.id)); return { ok: true };
});
route('GET', '/api/tickets/:id/attachment', async ({ u, p, res }) => {
  const t = one('SELECT * FROM tickets WHERE id=?', int(p.id)) || fail(404, 'مش موجودة');
  if (!canTicket(u, t)) fail(404, 'مفيش مرفق');
  if (!t.att_path && t.att_file_id) { const url = await bot.getFileUrl(t.att_file_id); if (!url) fail(502, 'تليجرام مارجعش الملف'); const r = await fetch(url); if (!r.ok) fail(502, 'تليجرام مارجعش الملف'); res.writeHead(200, { 'content-type': t.att_mime || 'application/octet-stream', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' }); return res.end(Buffer.from(await r.arrayBuffer())); }
  if (!t.att_path || !fs.existsSync(t.att_path)) fail(404, 'مفيش مرفق');
  res.writeHead(200, { 'content-type': t.att_mime || 'application/octet-stream', 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(t.att_name || 'file')}`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600' });
  fs.createReadStream(t.att_path).pipe(res);
});
route('GET', '/api/tickets/:id/reply-file', async ({ u, p, res }) => {
  const t = one('SELECT * FROM tickets WHERE id=?', int(p.id)) || fail(404, 'مش موجودة');
  if (!canTicket(u, t) || !(t.reply_file_id || t.reply_path)) fail(404, 'مفيش ملف');
  if (t.reply_path && fs.existsSync(t.reply_path)) { res.writeHead(200, { 'content-type': t.reply_mime || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600' }); return res.end(fs.readFileSync(t.reply_path)); }
  const url = await bot.getFileUrl(t.reply_file_id); if (!url) fail(502, 'تليجرام مارجعش الملف، استخدم زرار ابعتلي على تليجرام');
  const r = await fetch(url); if (!r.ok) fail(502, 'تليجرام مارجعش الملف');
  const types = { voice: 'audio/ogg', audio: 'audio/mpeg', photo: 'image/jpeg', video: 'video/mp4', video_note: 'video/mp4' };
  res.writeHead(200, { 'content-type': r.headers.get('content-type') && r.headers.get('content-type') !== 'application/octet-stream' ? r.headers.get('content-type') : (types[t.reply_kind] || 'application/octet-stream'), 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
  res.end(Buffer.from(await r.arrayBuffer()));
});

/* checklist & reports */
route('GET', '/api/checklist', async ({ u, q }) => {
  const id = u.role === 'coordinator' ? u.id : int(q.user) || fail(400, 'المستخدم مطلوب');
  if (u.role === 'supervisor' && !all('SELECT 1 FROM batches WHERE supervisor_id=? AND coordinator_id=?', u.id, id).length) fail(403, 'مش مسموح');
  if (!['coordinator', 'supervisor', 'admin'].includes(u.role)) fail(403, 'مش مسموح');
  return L.coordinatorReport(id, str(q.day, 10) || L.dayStr());
});
route('PUT', '/api/checklist', async ({ u, body }) => {
  need(u, 'coordinator');
  const weekly = body.item in L.WEEKLY; if (!(body.item in L.DAILY) && !weekly) fail(400, 'بند غير معروف');
  const period = weekly ? L.weekStr() : L.dayStr();
  run(`INSERT INTO checklist(user_id,period,item,done,note,done_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,period,item) DO UPDATE SET done=excluded.done, note=excluded.note, done_at=excluded.done_at`, u.id, period, body.item, body.done ? 1 : 0, str(body.note, 1000), body.done ? Date.now() : null);
  return { ok: true };
});
route('GET', '/api/reports', async ({ u, q }) => {
  const day = str(q.day, 10) || L.dayStr();
  if (u.role === 'supervisor') {
    const coords = all('SELECT DISTINCT u.id, u.name FROM batches b JOIN users u ON u.id=b.coordinator_id WHERE b.supervisor_id=?', u.id);
    return { day, mine: one('SELECT * FROM reports WHERE user_id=? AND day=?', u.id, day), draft: L.daySummary(u, Date.parse(day + 'T12:00:00Z')), team: coords.map(c => ({ ...c, report: L.coordinatorReport(c.id, day) })) };
  }
  if (u.role === 'admin') return { day, supervisors: all("SELECT u.id, u.name, r.body, r.created_at FROM users u LEFT JOIN reports r ON r.user_id=u.id AND r.day=? WHERE u.role='supervisor' AND u.active=1", day), summary: L.daySummary(u, Date.parse(day + 'T12:00:00Z')) };
  fail(403, 'مش مسموح');
});
route('PUT', '/api/reports', async ({ u, body }) => {
  need(u, 'supervisor');
  run('INSERT INTO reports(user_id,day,body,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET body=excluded.body, created_at=excluded.created_at', u.id, L.dayStr(), req1(str(body.body, 8000), 'التقرير'), Date.now());
  return { ok: true };
});
route('GET', '/api/daily-report', async ({ u, q }) => {
  need(u, 'admin', 'supervisor'); const day = /^\d{4}-\d{2}-\d{2}$/.test(q.day || '') ? q.day : L.dayStr();
  const t = day === L.dayStr() ? Date.now() : Date.parse(day + 'T12:00:00Z'), r = L.dailyReport(u, t);
  return { ...r, text: L.dailyReportText(r) };
});
route('POST', '/api/daily-report/send', async ({ u, body }) => {
  need(u, 'admin', 'supervisor'); const day = /^\d{4}-\d{2}-\d{2}$/.test(body.day || '') ? body.day : L.dayStr();
  const me = one('SELECT tg_id FROM users WHERE id=?', u.id); if (!me.tg_id) fail(400, 'اربط حسابك بالبوت الأول من صفحة حسابي');
  const t = day === L.dayStr() ? Date.now() : Date.parse(day + 'T12:00:00Z'); await bot.send(me.tg_id, L.dailyReportText(L.dailyReport(u, t))); return { ok: true };
}, { noAudit: true });
route('GET', '/api/prompt', async ({ u, q }) => { need(u, 'admin'); return { text: L.aiPrompt(q.day ? Date.parse(q.day + 'T12:00:00Z') : Date.now()) }; });

/* subscriptions & shift notes */
route('GET', '/api/subs', async ({ u, q }) => { need(u, 'admin', 'cs', 'supervisor', 'coordinator'); const bid = int(q.batch); if (bid && !canBatch(u, bid)) fail(403, 'مش مسموح'); return all(`SELECT s.*, b.code FROM subs s JOIN batches b ON b.id=s.batch_id ${bid ? 'WHERE s.batch_id=?' : ''} ORDER BY s.day DESC, s.id DESC LIMIT 300`, ...(bid ? [bid] : [])); });
route('POST', '/api/subs', async ({ u, body }) => {
  need(u, 'admin', 'cs');
  const rows = Array.isArray(body.rows) ? body.rows : [body], day = str(body.day, 10) || L.dayStr();
  tx(() => { for (const r of rows) { const c = int(r.count); if (c == null) continue; run('INSERT INTO subs(batch_id,day,count,by,created_at) VALUES(?,?,?,?,?)', req1(int(r.batch_id), 'الدفعة'), day, c, u.id, Date.now()); } });
  return { ok: true };
});
route('GET', '/api/shift', async ({ u }) => { need(u, 'admin', 'cs'); return all('SELECT s.*, u.name FROM shift_notes s JOIN users u ON u.id=s.user_id ORDER BY s.created_at DESC LIMIT 30'); });
route('POST', '/api/shift', async ({ u, body }) => { need(u, 'cs'); run('INSERT INTO shift_notes(user_id,body,created_at) VALUES(?,?,?)', u.id, req1(str(body.body), 'الملاحظة'), Date.now()); return { ok: true }; });

/* team */
route('GET', '/api/team', async ({ u }) => {
  need(u, 'admin', 'supervisor');
  if (u.role === 'supervisor') return { coordinators: all('SELECT DISTINCT u.id, u.name FROM batches b JOIN users u ON u.id=b.coordinator_id WHERE b.supervisor_id=?', u.id).map(c => ({ ...c, stats: L.coordinatorStats(c.id), batches: all('SELECT code FROM batches WHERE coordinator_id=? AND supervisor_id=?', c.id, u.id).map(b => b.code) })) };
  return {
    supervisors: all("SELECT id,name FROM users WHERE role='supervisor' AND active=1").map(s => ({ ...s, stats: L.supervisorStats(s.id) })),
    coordinators: all("SELECT id,name FROM users WHERE role='coordinator' AND active=1").map(c => ({ ...c, stats: L.coordinatorStats(c.id), batches: all('SELECT code FROM batches WHERE coordinator_id=?', c.id).map(b => b.code) })),
    cs: all("SELECT id,name FROM users WHERE role='cs' AND active=1").map(c => ({ ...c, stats: L.csStats(c.id) })),
  };
});

/* penalties */
route('GET', '/api/penalties', async ({ u }) => {
  const base = 'SELECT p.*, t.name target, t.role target_role, a.name proposer, d.name decider FROM penalties p JOIN users t ON t.id=p.user_id LEFT JOIN users a ON a.id=p.proposed_by LEFT JOIN users d ON d.id=p.decided_by';
  if (u.role === 'admin') return all(base + ' ORDER BY p.created_at DESC');
  if (u.role === 'doctor' || u.role === 'cs') return all(base + " WHERE p.user_id=? AND p.status!='proposed' ORDER BY p.created_at DESC", u.id);
  const docs = L.scopedDoctorIds(u), coords = u.role === 'supervisor' ? all('SELECT DISTINCT coordinator_id id FROM batches WHERE supervisor_id=?', u.id).map(r => r.id) : [];
  return all(base + ` WHERE (p.user_id IN (${L.inList([...docs, ...coords])}) OR p.proposed_by=? OR (p.user_id=? AND p.status!='proposed')) ORDER BY p.created_at DESC`, u.id, u.id);
});
route('POST', '/api/penalties', async ({ u, body }) => {
  need(u, 'admin', 'supervisor', 'coordinator');
  const target = one('SELECT * FROM users WHERE id=?', req1(int(body.user_id), 'الشخص')) || fail(400, 'مش موجود');
  if (u.role !== 'admin') { const ok = target.role === 'doctor' || (u.role === 'supervisor' && all('SELECT 1 FROM batches WHERE supervisor_id=? AND coordinator_id=?', u.id, target.id).length); if (!ok) fail(403, 'مش في نطاقك'); }
  const admin = u.role === 'admin', n = Date.now();
  const r = run('INSERT INTO penalties(user_id,reason,kind,amount,status,proposed_by,decided_by,created_at,decided_at) VALUES(?,?,?,?,?,?,?,?,?)', target.id, req1(str(body.reason, 500), 'السبب'), str(body.kind, 60) || 'خصم', real(body.amount) || 0, admin ? 'approved' : 'proposed', u.id, admin ? u.id : null, n, admin ? n : null);
  const pen = one('SELECT * FROM penalties WHERE id=?', Number(r.lastInsertRowid)); if (admin) await bot.notifyPenalty(pen);
  return { id: pen.id };
});
route('PATCH', '/api/penalties/:id', async ({ u, body, p }) => {
  const pen = one('SELECT * FROM penalties WHERE id=?', int(p.id)) || fail(404, 'مش موجود'); const n = Date.now();
  if (body.action === 'object') { if (pen.user_id !== u.id || pen.status === 'proposed') fail(403, 'مش مسموح'); run('UPDATE penalties SET objection=? WHERE id=?', req1(str(body.text, 1000), 'الاعتراض'), pen.id); return { ok: true }; }
  need(u, 'admin');
  if (body.action === 'approve') { run("UPDATE penalties SET status='approved', decided_by=?, decided_at=?, amount=COALESCE(?,amount) WHERE id=?", u.id, n, real(body.amount), pen.id); await bot.notifyPenalty(one('SELECT * FROM penalties WHERE id=?', pen.id)); }
  else if (body.action === 'reject') run("UPDATE penalties SET status='rejected', decided_by=?, decided_at=? WHERE id=?", u.id, n, pen.id);
  else if (body.action === 'reply') { run('UPDATE penalties SET reply=? WHERE id=?', req1(str(body.text, 1000), 'الرد'), pen.id); if (body.cancel && !pen.settlement_id) run("UPDATE penalties SET status='rejected' WHERE id=?", pen.id); }
  else fail(400, 'إجراء غير معروف');
  return { ok: true };
});

/* finance */
const isMonth = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
route('GET', '/api/finance', async ({ u, q }) => {
  need(u, 'admin'); const cur = L.dayStr().slice(0, 7), month = isMonth(q.month) ? q.month : cur;
  if (month !== cur) {
    const rows = all(`SELECT u.id, u.name, u.role, SUM(s.gross) gross, SUM(s.bonus) bonus, SUM(s.deductions) deductions, SUM(s.net) net, COUNT(s.id) n,
      SUM(s.paid_at IS NULL) unpaid, MAX(s.paid_at) paid_at, GROUP_CONCAT(s.id) sids FROM settlements s JOIN users u ON u.id=s.user_id WHERE s.period=? GROUP BY u.id ORDER BY net DESC`, month)
      .map(r => { const ids = String(r.sids).split(',').map(Number), tr = one(`SELECT MAX(confirmed_at) c, MAX(problem IS NOT NULL AND confirmed_at IS NULL) p, COUNT(*) n FROM transfer_msgs WHERE settlement_id IN (${ids.join(',')})`) || {};
        return { ...r, sids: ids, last_sid: Math.max(...ids), lectures: r.role === 'doctor' ? (one(`SELECT COUNT(*) n FROM lectures WHERE settlement_id IN (${ids.join(',')})`) || {}).n : 0, confirmed_at: tr.c || null, problem: !!tr.p, sent: tr.n || 0 }; });
    const open = all("SELECT id, name, role FROM users WHERE active=1 AND role!='admin' AND id NOT IN (SELECT user_id FROM settlements WHERE period=?) ORDER BY role, name", month);
    return { month, history: true, rows, open };
  }
  return { month, history: false, rows: all("SELECT id,name,role,salary FROM users WHERE active=1 AND role!='admin' ORDER BY role,name").map(x => { const pq = L.payable(x.id); return { ...x, gross: pq.gross, bonus: pq.bonus, deductions: pq.deductions, net: pq.net, lectures: pq.lecs.length, pending: pq.pendingLecs, payout: (one('SELECT COUNT(*) n FROM payout_methods WHERE user_id=?', x.id) || {}).n }; }).sort((a, b) => b.net - a.net) };
});
route('GET', '/api/finance/:id', async ({ u, p, q }) => {
  const id = int(p.id); if (u.role !== 'admin' && u.id !== id) fail(403, 'مش مسموح');
  const period = isMonth(q.period) ? q.period : null, pq = L.payable(id, Date.now(), period ? L.monthWin(period).to : undefined);
  const lecs = pq.lecs.map(l => ({ id: l.id, name: l.name, type: l.type, price: l.price, sent_at: l.sent_at, delivered_at: Math.max(l.video_at, l.q_at) }));
  return { period, user: one('SELECT id,name,role,salary,tg_username,whatsapp,phone,(tg_id IS NOT NULL) linked FROM users WHERE id=?', id), transfers: u.role === 'admin' ? all('SELECT id, note, file_name, mime, delivered, created_at, needs_confirm, confirmed_at, problem, problem_at, settlement_id, (file_path IS NOT NULL) has_file FROM transfer_msgs WHERE user_id=? ORDER BY created_at DESC LIMIT 20', id) : [],
    notes: u.role === 'admin' && one("SELECT 1 FROM users WHERE id=? AND role='doctor'", id) ? doctorNotes(id, u) : undefined, ...pq, lecs, payout: all('SELECT * FROM payout_methods WHERE user_id=? ORDER BY id', id), settlements: all('SELECT * FROM settlements WHERE user_id=? ORDER BY created_at DESC LIMIT 24', id) };
});
route('POST', '/api/finance/:id/settle', async ({ u, body, p }) => {
  need(u, 'admin'); const id = int(p.id), n = Date.now(), kind = body.kind === 'early' ? 'early' : 'month';
  const period = body.period ? (isMonth(body.period) ? body.period : fail(400, 'الشهر لازم يكون بالشكل 2026-11')) : L.dayStr().slice(0, 7);
  const pq = L.payable(id, n, kind === 'month' ? L.monthWin(period).to : undefined);
  const sid = tx(() => {
    const r = run('INSERT INTO settlements(user_id,kind,period,gross,bonus,deductions,net,detail,by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, kind, period, pq.gross, pq.bonus, pq.deductions, pq.net,
      JSON.stringify({ byType: pq.byType, salary: pq.salary, lectures: pq.lecs.map(l => l.id) }), u.id, n);
    const s = Number(r.lastInsertRowid);
    for (const [t, rows] of [['lectures', pq.lecs], ['penalties', pq.pens], ['bonuses', pq.bons], ['extra_pay', pq.extra]]) for (const x of rows) run(`UPDATE ${t} SET settlement_id=? WHERE id=?`, s, x.id);
    return s;
  });
  return { id: sid, net: pq.net };
});
route('PATCH', '/api/settlements/:id', async ({ u, p }) => { need(u, 'admin'); run('UPDATE settlements SET paid_at=? WHERE id=?', Date.now(), int(p.id)); return { ok: true }; });
function statementData(sid) {
  const s = one('SELECT * FROM settlements WHERE id=?', sid) || fail(404, 'التقفيل مش موجود'), d = JSON.parse(s.detail || '{}');
  const lectures = all('SELECT id, name, type, price, video_at, q_at FROM lectures WHERE settlement_id=? ORDER BY MAX(video_at,q_at)', sid).map(l => ({ ...l, delivered_at: Math.max(l.video_at, l.q_at) }));
  const byType = {}; for (const l of lectures) { const x = (byType[l.type] ||= { n: 0, sum: 0 }); x.n++; x.sum += l.price; }
  return { brand: setting('brand'), tz: L.TZ, user: one('SELECT id, name, role FROM users WHERE id=?', s.user_id), period: s.period, kind: s.kind, created_at: s.created_at, paid_at: s.paid_at,
    lectures, byType, salary: d.salary || 0, extras: all('SELECT amount, note FROM extra_pay WHERE settlement_id=?', sid), bonuses: all('SELECT amount, note FROM bonuses WHERE settlement_id=?', sid),
    penalties: all('SELECT amount, reason FROM penalties WHERE settlement_id=? AND amount>0', sid), gross: s.gross, bonus: s.bonus, deductions: s.deductions, net: s.net,
    payout: one('SELECT * FROM payout_methods WHERE user_id=? ORDER BY id LIMIT 1', s.user_id) };
}
const statementPdf = sid => PDF.statementPdf(statementData(sid));
route('GET', '/api/settlements/:id/pdf', async ({ u, p, res }) => {
  const s = one('SELECT id, user_id, period FROM settlements WHERE id=?', int(p.id)) || fail(404, 'مش موجود');
  if (u.role !== 'admin' && s.user_id !== u.id) fail(403, 'مش مسموح');
  const buf = statementPdf(s.id);
  res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="statement-${s.period}.pdf"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }); res.end(buf);
});
route('POST', '/api/settlements/:id/send', async ({ u, p }) => {
  need(u, 'admin'); const s = one('SELECT s.*, u.tg_id FROM settlements s JOIN users u ON u.id=s.user_id WHERE s.id=?', int(p.id)) || fail(404, 'مش موجود');
  if (!s.tg_id) fail(400, 'مش رابط البوت');
  const ok = await bot.sendFile('sendDocument', 'document', s.tg_id, statementPdf(s.id), `كشف-حساب-${s.period}.pdf`, `كشف حساب ${s.period}`, 'application/pdf');
  if (!ok) fail(502, 'ماوصلش، جرّب تاني'); return { ok: true };
});
route('POST', '/api/bonuses', async ({ u, body }) => { need(u, 'admin'); run('INSERT INTO bonuses(user_id,amount,note,by,created_at) VALUES(?,?,?,?,?)', req1(int(body.user_id), 'الشخص'), req1(real(body.amount), 'المبلغ'), str(body.note, 300), u.id, Date.now()); return { ok: true }; });
route('POST', '/api/extra', async ({ u, body }) => { need(u, 'admin'); run('INSERT INTO extra_pay(user_id,amount,note,by,created_at) VALUES(?,?,?,?,?)', req1(int(body.user_id), 'الشخص'), req1(real(body.amount), 'المبلغ'), str(body.note, 300), u.id, Date.now()); return { ok: true }; });

/* deletes (admin) */
route('DELETE', '/api/penalties/:id', async ({ u, p }) => { need(u, 'admin'); const x = one('SELECT settlement_id FROM penalties WHERE id=?', int(p.id)) || fail(404, 'مش موجود'); if (x.settlement_id) fail(400, 'دخل في حساب اتقفل، امسح التقفيل الأول'); run('DELETE FROM penalties WHERE id=?', int(p.id)); return { ok: true }; });
route('DELETE', '/api/bonuses/:id', async ({ u, p }) => { need(u, 'admin'); run('DELETE FROM bonuses WHERE id=? AND settlement_id IS NULL', int(p.id)); return { ok: true }; });
route('DELETE', '/api/extra/:id', async ({ u, p }) => { need(u, 'admin'); run('DELETE FROM extra_pay WHERE id=? AND settlement_id IS NULL', int(p.id)); return { ok: true }; });
route('DELETE', '/api/subs/:id', async ({ u, p }) => { need(u, 'admin'); run('DELETE FROM subs WHERE id=?', int(p.id)); return { ok: true }; });
route('DELETE', '/api/settlements/:id', async ({ u, p }) => {
  need(u, 'admin'); const id = int(p.id);
  tx(() => { for (const t of ['lectures', 'penalties', 'bonuses', 'extra_pay']) run(`UPDATE ${t} SET settlement_id=NULL WHERE settlement_id=?`, id); run('DELETE FROM settlements WHERE id=?', id); });
  return { ok: true };
});
route('DELETE', '/api/users/:id', async ({ u, p }) => {
  need(u, 'admin'); const id = int(p.id); if (id === u.id) fail(400, 'مينفعش تمسح نفسك');
  const used = one('SELECT (SELECT COUNT(*) FROM lectures WHERE doctor_id=?1 OR coordinator_id=?1) + (SELECT COUNT(*) FROM tickets WHERE created_by=?1 OR doctor_id=?1) + (SELECT COUNT(*) FROM settlements WHERE user_id=?1) + (SELECT COUNT(*) FROM batches WHERE supervisor_id=?1 OR coordinator_id=?1) n', id).n;
  if (used) fail(400, 'المستخدم ده ليه شغل متسجل أو دفعات، اقفل حسابه بدل المسح (شيل علامة الحساب شغال)');
  tx(() => { for (const t of ['penalties', 'bonuses', 'extra_pay', 'checklist', 'reports', 'shift_notes', 'rank_overrides']) run(`DELETE FROM ${t} WHERE user_id=?`, id); run('DELETE FROM doctors WHERE user_id=?', id); run('DELETE FROM users WHERE id=?', id); });
  return { ok: true };
});
route('POST', '/api/reset', async ({ u, body }) => {
  need(u, 'admin'); if (body.confirm !== 'امسح كل حاجة') fail(400, 'اكتب الجملة صح عشان تأكد');
  await jobs.backup();
  for (const f of fs.readdirSync(ATT)) fs.rmSync(path.join(ATT, f), { force: true });
  tx(() => { for (const t of ['tickets', 'price_log', 'lectures', 'checklist', 'reports', 'subs', 'penalties', 'bonuses', 'extra_pay', 'settlements', 'shift_notes', 'bot_pending', 'rank_overrides']) run(`DELETE FROM ${t}`); run("UPDATE batches SET exam_date=NULL, exam_note=NULL"); });
  if (body.doctors) { const ds = all("SELECT id FROM users WHERE role='doctor'"); tx(() => { for (const d of ds) { run('DELETE FROM doctors WHERE user_id=?', d.id); run('DELETE FROM users WHERE id=?', d.id); } }); }
  return { ok: true };
});

/* rankings */
const RANK_ROLES = { doctor: 'الدكاترة', coordinator: 'مسؤولين الدفعات', supervisor: 'المشرفين', cs: 'خدمة العملاء' };
function rankings(month) {
  const w = L.monthWin(month), out = {};
  for (const role of Object.keys(RANK_ROLES)) {
    const users = all('SELECT id, name FROM users WHERE role=? AND active=1', role);
    const rows = users.map(x => {
      let score, detail;
      if (role === 'doctor') { const s = L.doctorStats(x.id, w); score = s.assigned ? s.score.total : null; detail = `${s.delivered}/${s.assigned} محاضرة · التزام ${Math.round(s.compliance * 100)}%`; }
      else if (role === 'coordinator') { const s = L.coordinatorStats(x.id, w); score = s.score.total; detail = `ردود اتأخرت ${s.replyLate} · رفع اتأخر ${s.uploadLate}`; }
      else if (role === 'supervisor') { const s = L.supervisorStats(x.id, w); score = s.score.total; detail = `${s.batches} دفعة · مشاكل مفتوحة ${s.openProblems}`; }
      else { const s = L.csStats(x.id, w); score = s.handled ? s.score : null; detail = `${s.handled} تذكرة · اتأخر ${s.late}`; }
      return { id: x.id, name: x.name, score, detail };
    }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    rows.forEach((r, i) => (r.auto = i + 1));
    const ov = Object.fromEntries(all('SELECT user_id, position FROM rank_overrides WHERE month=? AND role=?', month, role).map(o => [o.user_id, o.position]));
    const fixed = rows.filter(r => ov[r.id]).sort((a, b) => ov[a.id] - ov[b.id]), free = rows.filter(r => !ov[r.id]);
    const final = new Array(rows.length).fill(null);
    for (const r of fixed) { let pos = Math.min(Math.max(1, ov[r.id]), rows.length) - 1; while (final[pos]) pos++; if (pos >= rows.length) pos = final.indexOf(null); final[pos] = { ...r, manual: true }; }
    for (const r of free) final[final.indexOf(null)] = r;
    out[role] = final.map((r, i) => ({ ...r, rank: i + 1 }));
  }
  return out;
}
route('GET', '/api/rankings', async ({ u, q }) => { need(u, 'admin'); const m = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : L.dayStr().slice(0, 7); return { month: m, roles: RANK_ROLES, lists: rankings(m) }; });
route('PUT', '/api/rankings', async ({ u, body }) => {
  need(u, 'admin'); const m = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month : fail(400, 'الشهر غلط');
  if (!(body.role in RANK_ROLES)) fail(400, 'الدور غلط');
  const pos = int(body.position), uid = req1(int(body.user_id), 'الشخص');
  if (!pos) run('DELETE FROM rank_overrides WHERE month=? AND role=? AND user_id=?', m, body.role, uid);
  else run('INSERT INTO rank_overrides(month,role,user_id,position,by,at) VALUES(?,?,?,?,?,?) ON CONFLICT(month,role,user_id) DO UPDATE SET position=excluded.position, by=excluded.by, at=excluded.at', m, body.role, uid, pos, u.id, Date.now());
  return { ok: true };
});

/* users & settings (admin) */
route('GET', '/api/users', async ({ u }) => { need(u, 'admin'); return all('SELECT u.id,u.name,u.email,u.role,u.active,u.salary,u.phone,u.link_code,(u.tg_id IS NOT NULL) linked, d.price_theory,d.price_practical,d.price_revision,d.capacity FROM users u LEFT JOIN doctors d ON d.user_id=u.id ORDER BY u.role,u.name'); });
route('POST', '/api/users', async ({ u, body }) => {
  need(u, 'admin');
  const role = ['admin', 'supervisor', 'coordinator', 'cs', 'doctor'].includes(body.role) ? body.role : fail(400, 'الصلاحية غلط');
  const pass = str(body.password, 100) || fail(400, 'كلمة المرور مطلوبة'); if (pass.length < 8) fail(400, 'كلمة المرور لازم 8 حروف على الأقل');
  const id = tx(() => {
    const r = run('INSERT INTO users(name,email,pass,role,salary,phone,link_code,created_at) VALUES(?,?,?,?,?,?,?,?)', req1(str(body.name, 100), 'الاسم'), req1(str(body.email, 200), 'الإيميل').toLowerCase(), A.hash(pass), role, real(body.salary) || 0, str(body.phone, 30), A.linkCode(), Date.now());
    const id = Number(r.lastInsertRowid);
    if (role === 'doctor') run('INSERT INTO doctors(user_id,price_theory,price_practical,price_revision,capacity) VALUES(?,?,?,?,?)', id, real(body.price_theory) || 0, real(body.price_practical) || 0, real(body.price_revision) || 0, int(body.capacity) || 3);
    return id;
  });
  return { id, link_code: one('SELECT link_code FROM users WHERE id=?', id).link_code };
});
route('PATCH', '/api/users/:id', async ({ u, body, p }) => {
  need(u, 'admin'); const id = int(p.id);
  for (const [k, f] of [['name', v => str(v, 100)], ['email', v => str(v, 200).toLowerCase()], ['salary', real], ['phone', v => str(v, 30)], ['active', int]]) if (k in body) run(`UPDATE users SET ${k}=? WHERE id=?`, f(body[k]), id);
  if (body.password) { if (String(body.password).length < 8) fail(400, 'كلمة المرور لازم 8 حروف على الأقل'); run('UPDATE users SET pass=? WHERE id=?', A.hash(body.password), id); }
  if (body.new_code) run('UPDATE users SET link_code=?, tg_id=NULL WHERE id=?', A.linkCode(), id);
  return { ok: true };
});
const ACT = {
  'POST /api/lectures': 'بعت محاضرة جديدة', 'PATCH /api/lectures/:id': { approve: 'اعتمد ملفات محاضرة', rate: 'قيّم محاضرة', uploaded: 'سجّل رفع محاضرة على Nerdio', price: 'عدّل سعر محاضرة', forward: 'طلب ملفات محاضرة على تليجرام', priority: 'غيّر أولوية محاضرة', excuse: 'استثنى محاضرة من التأخير', unexcuse: 'شال استثناء التأخير', exempt_q: 'أعفى محاضرة من ملف الأسئلة', unexempt_q: 'لغى إعفاء ملف الأسئلة', cancel: 'مسح محاضرة' },
  'POST /api/tickets': 'فتح تذكرة', 'PATCH /api/tickets/:id': { send_doctor: 'بعت سؤال للدكتور', set_reply: 'سجّل رد الدكتور', return: 'رجّع الرد لخدمة العملاء', deliver: 'سجّل إن الرد وصل للطالب', delete: 'مسح تذكرة', forward: 'طلب تذكرة على تليجرام', close: 'قفل مشكلة' },
  'PATCH /api/doctors/:id': 'عدّل تعاقد دكتور', 'POST /api/doctors/:id/queue': 'رتّب محاضرات دكتور', 'POST /api/doctors/:id/notes': 'كتب ملاحظة على دكتور', 'DELETE /api/notes/:id': 'مسح ملاحظة على دكتور',
  'PUT /api/checklist': 'حدّث مهام اليوم', 'PUT /api/reports': 'رفع التقرير اليومي', 'POST /api/subs': 'سجّل اشتراكات', 'POST /api/shift': 'كتب ملاحظة شيفت',
  'POST /api/penalties': 'سجّل قرار', 'PATCH /api/penalties/:id': { object: 'اعترض على قرار', approve: 'اعتمد قرار', reject: 'رفض قرار', reply: 'رد على اعتراض' },
  'POST /api/finance/:id/settle': 'قفل حساب', 'PATCH /api/settlements/:id': 'سجّل دفع حساب', 'POST /api/finance/:id/message': 'بعت إيصال أو رسالة حسابات', 'POST /api/settlements/:id/send': 'بعت كشف حساب على البوت',
  'POST /api/bonuses': 'ضاف بونص', 'POST /api/extra': 'ضاف مستحق إضافي', 'DELETE /api/penalties/:id': 'مسح قرار', 'DELETE /api/bonuses/:id': 'مسح بونص', 'DELETE /api/extra/:id': 'مسح مستحق إضافي',
  'DELETE /api/subs/:id': 'مسح تسجيل اشتراكات', 'DELETE /api/settlements/:id': 'لغى تقفيل حساب', 'DELETE /api/users/:id': 'مسح مستخدم', 'POST /api/reset': 'مسح كل بيانات التجربة',
  'PUT /api/rankings': 'عدّل الترتيب', 'POST /api/users': 'ضاف مستخدم', 'PATCH /api/users/:id': 'عدّل بيانات مستخدم', 'PUT /api/settings': 'غيّر الإعدادات', 'POST /api/backup': 'عمل نسخة احتياطية',
  'POST /api/universities': 'ضاف جامعة', 'PATCH /api/universities/:id': 'عدّل جامعة', 'POST /api/batches': 'ضاف دفعة', 'PATCH /api/batches/:id': 'عدّل دفعة', 'POST /api/me/password': 'غيّر كلمة المرور', 'POST /api/impersonate-stop': 'رجع لحسابه',
};
const EVT = { login: 'سجّل دخول', impersonate: 'دخل على حساب', tg_link: 'ربط حسابه بالبوت', deliver: 'سلّم ملف محاضرة من البوت', ticket_send_doctor: 'بعت سؤال للدكتور من البوت', ticket_return: 'رجّع رد لخدمة العملاء من البوت', ticket_deliver: 'سجّل إن الرد وصل للطالب من البوت', ticket_bot_new: 'فتح تذكرة من البوت', ticket_bot_close: 'قفل مشكلة من البوت', transfer_confirm: 'أكد استلام التحويل', transfer_problem: 'بلّغ عن مشكلة في التحويل' };
const KEEP = ['item', 'done', 'amount', 'price', 'reason', 'kind', 'note', 'period', 'name', 'role', 'priority', 'position', 'month', 'type', 'body', 'text', 'video', 'q', 'active', 'salary', 'email'];
function logAction(req, u, r, pathname, p, body) {
  const imp = A.impFromReq(req), b = {};
  for (const k of KEEP) if (body[k] != null && body[k] !== '') b[k] = String(body[k]).slice(0, 120);
  audit(u.id, 'api', { k: `${r.method} ${r.pattern}`, a: body.action || null, id: p.id ? Number(p.id) : null, b }, imp && imp.id !== u.id ? imp.id : null);
}
function targetOf(k, id) {
  if (!id) return '';
  if (k.includes('/lectures/')) { const l = one('SELECT name FROM lectures WHERE id=?', id); return `محاضرة #${id}${l ? ' ' + l.name : ''}`; }
  if (k.includes('/tickets/')) return `تذكرة #${id}`;
  if (/\/(doctors|users|finance)\//.test(k)) { const x = one('SELECT name FROM users WHERE id=?', id); return x ? x.name : `#${id}`; }
  if (k.includes('/settlements/')) { const s = one('SELECT s.period, u.name FROM settlements s JOIN users u ON u.id=s.user_id WHERE s.id=?', id); return s ? `${s.name} · ${s.period}` : `تقفيل #${id}`; }
  if (k.includes('/batches/')) { const x = one('SELECT code FROM batches WHERE id=?', id); return x ? `دفعة ${x.code}` : ''; }
  if (k.includes('/penalties/')) { const x = one('SELECT u.name FROM penalties p JOIN users u ON u.id=p.user_id WHERE p.id=?', id); return x ? `قرار على ${x.name}` : ''; }
  return `#${id}`;
}
const FLD = { item: 'البند', done: 'خلّص', amount: 'المبلغ', price: 'السعر', reason: 'السبب', kind: 'النوع', note: 'ملاحظة', period: 'الفترة', name: 'الاسم', role: 'الدور', priority: 'الأولوية', position: 'المركز', month: 'الشهر', type: 'النوع', body: 'النص', text: 'النص', active: 'شغال', salary: 'المرتب', email: 'الإيميل' };
const VAL = { month: 'شهري', early: 'معجّل', question: 'سؤال', problem: 'مشكلة', true: 'آه', false: 'لأ', ...L.TYPES, ...ROLE_AR };
const auditVal = (k, v) => (k === 'priority' ? L.PRIORITY[v] ?? v : k === 'item' ? L.DAILY[v] || L.WEEKLY[v] || v : k === 'active' ? (String(v) === '1' ? 'آه' : 'لأ') : ['kind', 'type', 'role', 'done'].includes(k) ? VAL[v] ?? v : v);
route('GET', '/api/audit', async ({ u, q }) => {
  need(u, 'admin');
  const where = ['1=1'], args = [];
  if (int(q.user)) { where.push('(a.user_id=? OR a.as_admin=?)'); args.push(int(q.user), int(q.user)); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.day || '')) { const t0 = L.dayStart(Date.parse(q.day + 'T12:00:00Z')); where.push('a.at>=? AND a.at<?'); args.push(t0, t0 + L.DAY); }
  if (q.before) { where.push('a.id<?'); args.push(int(q.before)); }
  const rows = all(`SELECT a.*, u.name, u.role, ad.name admin_name FROM audit a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN users ad ON ad.id=a.as_admin WHERE ${where.map(w => `(${w})`).join(' AND ')} ORDER BY a.id DESC LIMIT 150`, ...args);
  const out = rows.map(a => {
    const d = a.detail ? JSON.parse(a.detail) : {};
    let what, target = '', extra = '';
    if (a.action === 'api') { const v = ACT[d.k]; what = typeof v === 'object' ? v[d.a] || `${d.k} (${d.a})` : v || d.k; target = targetOf(d.k, d.id); extra = Object.entries(d.b || {}).filter(([k]) => FLD[k]).map(([k, v]) => `${FLD[k]}: ${auditVal(k, v)}`).join(' · '); }
    else if (a.action === 'profile_change') what = d.what || 'غيّر بياناته';
    else { what = EVT[a.action] || a.action; if (d.lecture) target = targetOf('/lectures/', d.lecture); else if (d.id && a.action.startsWith('ticket')) target = `تذكرة #${d.id}`; else if (d.as) target = (one('SELECT name FROM users WHERE id=?', d.as) || {}).name || ''; }
    return { id: a.id, at: a.at, user_id: a.user_id, name: a.name || '—', role: a.role, admin_name: a.admin_name, what, target, extra };
  });
  return { rows: out, more: rows.length === 150 ? rows.at(-1).id : null, users: all('SELECT id, name, role FROM users ORDER BY role, name') };
});
route('GET', '/api/settings', async ({ u }) => { need(u, 'admin'); return Object.fromEntries(all("SELECT key,value FROM settings WHERE key NOT LIKE 'last_%'").map(r => [r.key, r.value])); });
const ALERT_KEYS = ['remind_before_hours', 'upload_alert_minutes', 'send_alert_minutes', 'return_alert_minutes', 'deliver_alert_minutes', 'due_alert_minutes', 'sup_grace_minutes'];
route('PUT', '/api/settings', async ({ u, body }) => {
  need(u, 'admin');
  for (const k of ALERT_KEYS) if (k in body) { const v = String(body[k]).trim(); if (v && !/^[\d.]+([,،\s]+[\d.]+)*$/.test(v)) fail(400, 'التنبيهات: اكتب أرقام بينها فاصلة، زي 6, 3, 1'); if (k === 'sup_grace_minutes' && !(Number(v) > 0)) fail(400, 'مهلة المشرف لازم رقم'); }
  for (const k of ALERT_KEYS) if (k in body && String(body[k]).trim() === '' && k !== 'sup_grace_minutes') run("INSERT INTO settings(key,value) VALUES(?,'0') ON CONFLICT(key) DO UPDATE SET value='0'", k);
  for (const k of ['deadline_hours', 'upload_minutes', 'coord_reply_minutes', 'cs_reply_minutes', 'exam_alert_days', 'report_time', 'backup_time', 'brand', ...ALERT_KEYS])
    if (k in body && String(body[k]).trim() !== '') run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(body[k]).trim().slice(0, 60));
  return { ok: true };
});
route('POST', '/api/backup', async ({ u }) => { need(u, 'admin'); const f = await jobs.backup(); return { ok: !!f }; });

/* ---------------- http plumbing ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, 'الملف كبير')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}
async function parse(req) {
  const ct = req.headers['content-type'] || '', buf = await readBody(req), out = { body: {}, files: {} };
  if (!buf.length) return out;
  if (ct.includes('application/json')) { try { out.body = JSON.parse(buf.toString('utf8')); } catch { fail(400, 'JSON غلط'); } }
  else if (ct.includes('multipart/form-data')) {
    const fd = await new Response(buf, { headers: { 'content-type': ct } }).formData();
    for (const [k, v] of fd.entries()) {
      if (typeof v === 'string') out.body[k] = v;
      else if (v.size) out.files[k] = { buf: Buffer.from(await v.arrayBuffer()), name: v.name || 'file', mime: v.type };
    }
  }
  return out;
}
function send(res, code, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(code, { 'content-type': typeof data === 'object' && !Buffer.isBuffer(data) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', ...headers });
  res.end(body);
}
function serveStatic(req, res, pathname) {
  let f = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': f.endsWith('index.html') ? 'no-cache' : 'public, max-age=300', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
  fs.createReadStream(f).pipe(res);
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const pathname = url.pathname;
  try {
    if (req.method === 'GET' && pathname === '/healthz') return send(res, 200, { ok: true, version: VERSION });
    if (pathname.startsWith('/tg/')) {
      if (!WEBHOOK || pathname !== '/tg/' + WEBHOOK || req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK) return send(res, 404, 'not found');
      const upd = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      send(res, 200, { ok: true });
      return bot.handleUpdate(upd).catch(e => console.error('update', e));
    }
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'vm') fail(403, 'طلب غير مسموح'); // CSRF guard
    const r = routes.find(x => x.method === req.method && x.re.test(pathname)) || fail(404, 'مش موجود');
    const u = A.userFromReq(req); if (!r.public && !u) fail(401, 'سجل دخول الأول');
    const { body, files } = req.method === 'GET' ? { body: {}, files: {} } : await parse(req);
    const p = r.re.exec(pathname).groups || {};
    const out = await r.fn({ req, res, u, body, files, q: Object.fromEntries(url.searchParams), p });
    if (req.method !== 'GET' && u && !r.noAudit) try { logAction(req, u, r, pathname, p, body); } catch (e) { console.error('audit', e.message); }
    if (!res.headersSent) send(res, 200, out ?? { ok: true });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    if (/UNIQUE constraint failed: users.email/.test(e.message)) return send(res, 400, { error: 'الإيميل ده مستخدم قبل كده' });
    if (/UNIQUE constraint failed/.test(e.message)) return send(res, 400, { error: 'القيمة دي موجودة قبل كده' });
    console.error(e); send(res, 500, { error: 'حصل خطأ في السيرفر' });
  }
});

if (require.main === module) {
  if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) { console.error('SESSION_SECRET لازم يكون 32 حرف على الأقل في ملف .env'); process.exit(1); }
  server.listen(PORT, () => console.log(`VitalMedX on :${PORT}`));
  if (process.env.NO_JOBS !== '1') jobs.start();
}
module.exports = { server };
