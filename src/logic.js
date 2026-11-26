'use strict';
const { one, all, num, setting } = require('./db');

const H = 3600e3, DAY = 864e5;
const now = () => Date.now();
const deadline = () => num('deadline_hours') * H;
const PRIORITY = { 0: 'غير مهم', 1: 'عادي', 2: 'مهم', 3: 'مهم جداً' };
const TYPES = { theory: 'نظري', practical: 'عملي', revision: 'مراجعة', repeat: 'معادة' };
const DAILY = { new_data: 'الداتا الجديدة اتبعتت للدكاترة', changed: 'المحاضرات المتغيرة اتراجعت واتبعتت', uploaded: 'اللي اتسلم اترفع على Nerdio وقناة تليجرام',
  questions: 'أسئلة الطلبة اتوصّلت وردودها رجعت', post: 'بوست في القناة العامة', remind: 'تذكير الدكاترة بالمحاضرات المتأخرة' };
const WEEKLY = { feedback: 'فيدباك من أدمن الدفعة عن الشرح', ideas: 'فكرتين لتنشيط الاشتراكات' };

// Cairo-local day string
const TZ = process.env.TZ_NAME || 'Africa/Cairo';
const dayStr = (t = now()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
function weekStr(t = now()) { const d = new Date(dayStr(t) + 'T00:00:00Z'); const dow = (d.getUTCDay() + 1) % 7; d.setUTCDate(d.getUTCDate() - dow); return 'W' + d.toISOString().slice(0, 10); } // week starts Saturday
function tzOffset(t) { const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(t).find(x => x.type === 'timeZoneName').value; return p === 'GMT' ? '+00:00' : p.slice(3); }
const dayStart = (t = now()) => Date.parse(dayStr(t) + 'T00:00:00' + tzOffset(t)); // ms of local midnight
const localHM = (t = now()) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ratio = (a, b, dflt = 1) => (b ? a / b : dflt);

/* ---------- scope ---------- */
function batchIds(u) {
  if (u.role === 'supervisor') return all('SELECT id FROM batches WHERE supervisor_id=?', u.id).map(r => r.id);
  if (u.role === 'coordinator') return all('SELECT id FROM batches WHERE coordinator_id=?', u.id).map(r => r.id);
  return null; // all
}
const inList = ids => (ids.length ? ids.join(',') : '-1');
function scopedLectures(u, extra = '', ...args) {
  if (u.role === 'doctor') return all(`SELECT * FROM lectures WHERE doctor_id=? ${extra}`, u.id, ...args);
  const ids = batchIds(u);
  return all(`SELECT * FROM lectures WHERE ${ids ? `batch_id IN (${inList(ids)})` : '1=1'} ${extra}`, ...args);
}
function scopedDoctorIds(u) {
  const ids = batchIds(u);
  if (!ids) return all("SELECT id FROM users WHERE role='doctor'").map(r => r.id);
  return all(`SELECT DISTINCT doctor_id id FROM lectures WHERE batch_id IN (${inList(ids)})`).map(r => r.id);
}

/* ---------- lecture state ---------- */
function fileState(at, ok, sent, ex) {
  if (!at) return !ex && now() - sent > deadline() ? 'overdue' : 'pending';
  return ok ? 'approved' : 'review';
}
const isLate = (at, sent, ex) => (ex ? false : at ? at - sent > deadline() : now() - sent > deadline());
const delivered = l => !!(l.video_at && l.q_at);
const deliveredAt = l => (delivered(l) ? Math.max(l.video_at, l.q_at) : null);
function lectureState(l) {
  const a = fileState(l.video_at, l.video_ok_at, l.sent_at, l.excused), b = fileState(l.q_at, l.q_ok_at, l.sent_at, l.excused);
  if (a === 'overdue' || b === 'overdue') return 'late';
  if (a === 'pending' || b === 'pending') return 'progress';
  if (!(l.video_ok_at && l.q_ok_at)) return 'review';
  return l.uploaded_at ? 'done' : 'upload';
}
const uploadLate = l => { const d = l.video_ok_at && l.q_ok_at ? Math.max(l.video_ok_at, l.q_ok_at) : null; if (!d) return false; const lim = num('upload_minutes') * 60e3; return l.uploaded_at ? l.uploaded_at - d > lim : now() - d > lim; };
function decorate(l) {
  const b = one('SELECT b.code, b.year, u.name uni FROM batches b JOIN universities u ON u.id=b.university_id WHERE b.id=?', l.batch_id) || {};
  const d = one('SELECT name FROM users WHERE id=?', l.doctor_id) || {}, c = one('SELECT name FROM users WHERE id=?', l.coordinator_id) || {};
  const qs = l.no_q ? 'na' : fileState(l.q_at, l.q_ok_at, l.sent_at, l.excused);
  return { ...l, batch_code: b.code, batch_year: b.year, university: b.uni, doctor: d.name, coordinator: c.name, state: lectureState(l),
    v_state: fileState(l.video_at, l.video_ok_at, l.sent_at, l.excused), q_state: qs,
    v_late: isLate(l.video_at, l.sent_at, l.excused), q_late: isLate(l.q_at, l.sent_at, l.excused), upload_late: uploadLate(l), deadline_at: l.sent_at + deadline() };
}

/* ---------- doctors ---------- */
function doctorStats(id, w) {
  const ls = w ? all('SELECT * FROM lectures WHERE doctor_id=? AND sent_at>=? AND sent_at<?', id, w.from, w.to) : all('SELECT * FROM lectures WHERE doctor_id=?', id);
  const doc = one('SELECT * FROM doctors WHERE user_id=?', id) || { capacity: 3, adj: 0 };
  let due = 0, onTime = 0, lateEver = 0, lateNow = 0, deliveredN = 0; const vT = [], qT = [];
  const t0 = dayStart(), m0 = now() - 30 * DAY; let today = 0, month = 0;
  for (const l of ls) {
    for (const [at, arr] of [[l.video_at, vT], [l.q_at, qT]]) {
      if (fileState(at, 1, l.sent_at, l.excused) !== 'pending') { due++; if (!isLate(at, l.sent_at, l.excused)) onTime++; }
      if (at && !(l.no_q && arr === qT)) arr.push(at - l.sent_at);
    }
    if (isLate(l.video_at, l.sent_at, l.excused) || isLate(l.q_at, l.sent_at, l.excused)) lateEver++;
    if (lectureState(l) === 'late') lateNow++;
    if (delivered(l)) { deliveredN++; const d = deliveredAt(l); if (d >= t0) today++; if (d >= m0) month++; }
  }
  // capacity shortfall: days in last 30 where lectures sent within capacity weren't delivered on time
  const byDay = {};
  for (const l of ls) if (l.sent_at >= m0 && now() - l.sent_at > deadline()) (byDay[dayStr(l.sent_at)] ||= []).push(l);
  let shortDays = 0;
  for (const arr of Object.values(byDay)) { const capped = arr.sort((a, b) => a.sent_at - b.sent_at).slice(0, doc.capacity); if (capped.some(l => isLate(l.video_at, l.sent_at, l.excused) || isLate(l.q_at, l.sent_at, l.excused))) shortDays++; }
  const rated = ls.filter(l => l.r_video != null);
  const avgOf = k => (rated.length ? rated.reduce((s, l) => s + (l[k] || 0), 0) / rated.length : null);
  const comp = ratio(onTime, due);
  const sc = { dl: 35 * comp, video: avgOf('r_video'), q: avgOf('r_q'), instr: avgOf('r_instr'), comm: avgOf('r_comm') };
  const q = [sc.video ?? 40, sc.q ?? 10, sc.instr ?? 10, sc.comm ?? 5].reduce((a, b) => a + b, 0);
  sc.total = Math.round(clamp(sc.dl + q + (doc.adj || 0), 0, 100));
  const sentToday = ls.filter(l => l.sent_at >= t0).length;
  return { assigned: ls.length, delivered: deliveredN, open: ls.filter(l => !delivered(l)).length, lateNow, lateEver, compliance: comp,
    avgVideo: vT.length ? vT.reduce((a, b) => a + b, 0) / vT.length : null, avgQ: qT.length ? qT.reduce((a, b) => a + b, 0) / qT.length : null,
    today, month, shortDays, capacity: doc.capacity, sentToday, rated: rated.length, score: sc, adj: doc.adj || 0 };
}

/* ---------- subscriptions ---------- */
const latestSubs = bid => all('SELECT count, day FROM subs WHERE batch_id=? ORDER BY day DESC, id DESC LIMIT 2', bid);
function subsRatio(bids, upto) {
  const rs = [];
  for (const id of bids) { const b = one('SELECT expected_subs FROM batches WHERE id=?', id); const s = upto ? one('SELECT count FROM subs WHERE batch_id=? AND day<=? ORDER BY day DESC, id DESC LIMIT 1', id, upto) : latestSubs(id)[0]; if (b && b.expected_subs > 0 && s) rs.push(clamp(s.count / b.expected_subs, 0, 1)); }
  return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 1;
}

/* ---------- team ratings ---------- */
const defWin = () => ({ from: now() - 30 * DAY, to: now() + 1 });
const winDays = w => Math.max(1, Math.ceil((Math.min(w.to, now()) - w.from) / DAY));
function coordinatorStats(id, w = defWin()) {
  const bids = all('SELECT id FROM batches WHERE coordinator_id=?', id).map(r => r.id);
  const tk = all(`SELECT * FROM tickets WHERE batch_id IN (${inList(bids)}) AND created_at>=? AND created_at<?`, w.from, w.to);
  const lim = num('coord_reply_minutes') * 60e3;
  const rep = tk.filter(t => t.reply_at), repOk = rep.filter(t => (t.returned_at || now()) - t.reply_at <= lim);
  const ls = all(`SELECT * FROM lectures WHERE batch_id IN (${inList(bids)}) AND sent_at>=? AND sent_at<?`, w.from, w.to).filter(l => l.video_ok_at && l.q_ok_at);
  const upOk = ls.filter(l => !uploadLate(l));
  const probs = tk.filter(t => t.kind === 'problem'), probsClosed = probs.filter(t => t.closed_at);
  const days = Math.min(winDays(w), 31), items = Object.keys(DAILY).length * days;
  const done = (one(`SELECT COUNT(*) n FROM checklist WHERE user_id=? AND done=1 AND period>=? AND period<=? AND period NOT LIKE 'W%'`, id, dayStr(w.from), dayStr(Math.min(w.to - 1, now()))) || {}).n;
  const s = { subs: 30 * subsRatio(bids, dayStr(Math.min(w.to - 1, now()))), deadlines: 30 * ratio(repOk.length + upOk.length, rep.length + ls.length), problems: 20 * ratio(probsClosed.length, probs.length), checklist: 20 * clamp(done / items, 0, 1) };
  s.total = Math.round(s.subs + s.deadlines + s.problems + s.checklist);
  return { batches: bids.length, replyLate: rep.length - repOk.length, uploadLate: ls.length - upOk.length, openProblems: probs.length - probsClosed.length, score: s };
}
function supervisorStats(id, w = defWin()) {
  const bids = all('SELECT id FROM batches WHERE supervisor_id=?', id).map(r => r.id);
  const ls = all(`SELECT * FROM lectures WHERE batch_id IN (${inList(bids)}) AND sent_at>=? AND sent_at<?`, w.from, w.to);
  let due = 0, ok = 0; for (const l of ls) for (const at of [l.video_at, l.q_at]) if (fileState(at, 1, l.sent_at, l.excused) !== 'pending') { due++; if (!isLate(at, l.sent_at, l.excused)) ok++; }
  const appr = ls.filter(l => l.video_ok_at && l.q_ok_at); const up = appr.filter(l => !uploadLate(l));
  const probs = all(`SELECT * FROM tickets WHERE kind='problem' AND batch_id IN (${inList(bids)}) AND created_at>=? AND created_at<?`, w.from, w.to);
  const open = probs.filter(p => !p.closed_at).length;
  const days = Math.min(winDays(w), 31);
  const reps = (one('SELECT COUNT(*) n FROM reports WHERE user_id=? AND day>=? AND day<=?', id, dayStr(w.from), dayStr(Math.min(w.to - 1, now()))) || {}).n;
  const s = { subs: 40 * subsRatio(bids, dayStr(Math.min(w.to - 1, now()))), delays: 30 * ratio(ok + up.length, due + appr.length), problems: 20 * (1 - ratio(open, probs.length, 0)), reports: 10 * clamp(reps / days, 0, 1) };
  s.total = Math.round(s.subs + s.delays + s.problems + s.reports);
  return { batches: bids.length, openProblems: open, lateNow: ls.filter(l => lectureState(l) === 'late').length, score: s };
}
function csStats(id, w = defWin()) {
  const lim = num('cs_reply_minutes') * 60e3;
  const tk = all('SELECT * FROM tickets WHERE returned_at IS NOT NULL AND returned_at>=? AND returned_at<?', w.from, w.to);
  const mine = tk.filter(t => t.delivered_by === id || (!t.delivered_by && t.created_by === id));
  const ok = mine.filter(t => t.delivered_at && t.delivered_at - t.returned_at <= lim);
  return { handled: mine.length, late: mine.length - ok.length, created: (one('SELECT COUNT(*) n FROM tickets WHERE created_by=? AND created_at>=? AND created_at<?', id, w.from, w.to) || {}).n, score: Math.round(100 * ratio(ok.length, mine.length)) };
}
function monthWin(m) { // 'YYYY-MM'
  const [y, mo] = m.split('-').map(Number); const nx = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  const from = Date.parse(`${m}-01T00:00:00${tzOffset(Date.parse(m + '-15T12:00:00Z'))}`), to = Date.parse(`${nx}-01T00:00:00${tzOffset(Date.parse(nx + '-15T12:00:00Z'))}`);
  return { from, to };
}

/* ---------- finance ---------- */
function payable(userId, until = now(), sentBefore = 9e15) { // sentBefore: month-close = only lectures sent before the month ends
  const u = one('SELECT id, role, salary FROM users WHERE id=?', userId);
  const lecs = u.role === 'doctor' ? all('SELECT id, name, type, price, batch_id, sent_at, video_at, q_at FROM lectures WHERE doctor_id=? AND settlement_id IS NULL AND video_at IS NOT NULL AND q_at IS NOT NULL AND MAX(video_at,q_at)<=? AND sent_at<?', userId, until, sentBefore) : [];
  const pens = all("SELECT id, reason, amount FROM penalties WHERE user_id=? AND status='approved' AND settlement_id IS NULL AND amount>0", userId);
  const bons = all('SELECT id, note, amount FROM bonuses WHERE user_id=? AND settlement_id IS NULL', userId);
  const extra = all('SELECT id, note, amount FROM extra_pay WHERE user_id=? AND settlement_id IS NULL', userId);
  const byType = {}; for (const l of lecs) { const t = (byType[l.type] ||= { n: 0, sum: 0 }); t.n++; t.sum += l.price; }
  const gross = lecs.reduce((s, l) => s + l.price, 0) + (u.role !== 'doctor' ? u.salary : 0) + extra.reduce((s, e) => s + e.amount, 0);
  const bonus = bons.reduce((s, b) => s + b.amount, 0), deductions = pens.reduce((s, p) => s + p.amount, 0);
  const pendingLecs = u.role === 'doctor' ? (one('SELECT COUNT(*) n FROM lectures WHERE doctor_id=? AND settlement_id IS NULL AND (video_at IS NULL OR q_at IS NULL)', userId) || {}).n : 0;
  return { lecs, pens, bons, extra, byType, salary: u.role !== 'doctor' ? u.salary : 0, gross, bonus, deductions, net: gross + bonus - deductions, pendingLecs };
}

/* ---------- daily summary + AI prompt ---------- */
function daySummary(u, t = now()) {
  const t0 = dayStart(t), t1 = t0 + DAY, ls = scopedLectures(u);
  const inDay = x => x && x >= t0 && x < t1;
  const ids = batchIds(u), tk = all(`SELECT * FROM tickets WHERE ${ids ? `batch_id IN (${inList(ids)})` : '1=1'}`);
  const lim = num('coord_reply_minutes') * 60e3, csLim = num('cs_reply_minutes') * 60e3;
  return {
    sent: ls.filter(l => inDay(l.sent_at)).length, videos: ls.filter(l => inDay(l.video_at)).length, qfiles: ls.filter(l => inDay(l.q_at) && !l.no_q).length,
    uploaded: ls.filter(l => inDay(l.uploaded_at)).length, lateNow: ls.filter(l => lectureState(l) === 'late').length,
    progress: ls.filter(l => lectureState(l) === 'progress').length, toUpload: ls.filter(l => lectureState(l) === 'upload').length,
    questions: tk.filter(x => x.kind === 'question' && inDay(x.created_at)).length,
    ticketsLate: tk.filter(x => (x.reply_at && (x.returned_at || now()) - x.reply_at > lim) || (x.returned_at && (x.delivered_at || now()) - x.returned_at > csLim)).filter(x => inDay(x.created_at) || !x.closed_at).length,
    problemsNew: tk.filter(x => x.kind === 'problem' && inDay(x.created_at)).length, problemsClosed: tk.filter(x => x.kind === 'problem' && inDay(x.closed_at)).length,
    problemsOpen: tk.filter(x => x.kind === 'problem' && !x.closed_at).length,
  };
}
function batchRows(u) {
  const ids = batchIds(u);
  return all(`SELECT b.*, un.name uni, un.code ucode, s.name supervisor, c.name coordinator FROM batches b JOIN universities un ON un.id=b.university_id
    LEFT JOIN users s ON s.id=b.supervisor_id LEFT JOIN users c ON c.id=b.coordinator_id WHERE b.active=1 ${ids ? `AND b.id IN (${inList(ids)})` : ''} ORDER BY un.code, b.code`)
    .map(b => {
      const ls = all('SELECT * FROM lectures WHERE batch_id=?', b.id), sb = latestSubs(b.id);
      const days = b.exam_date ? Math.ceil((Date.parse(b.exam_date + 'T00:00:00Z') - Date.parse(dayStr() + 'T00:00:00Z')) / DAY) : null;
      const revisions = ls.filter(l => l.type === 'revision' && delivered(l)).length;
      return { ...b, subs: sb[0]?.count ?? null, subs_prev: sb[1]?.count ?? null, subs_day: sb[0]?.day ?? null, lectures: ls.filter(l => delivered(l) && l.type !== 'revision').length,
        revisions, qfiles: ls.filter(l => l.q_at && !l.no_q).length, lateNow: ls.filter(l => lectureState(l) === 'late').length,
        problems: (one("SELECT COUNT(*) n FROM tickets WHERE kind='problem' AND batch_id=? AND closed_at IS NULL", b.id) || {}).n,
        exam_days: days, exam_alert: days != null && days >= 0 && days <= num('exam_alert_days') && revisions === 0 };
    });
}
function alerts(u) {
  const out = [];
  for (const l of scopedLectures(u)) {
    const st = lectureState(l);
    if (st === 'late') out.push({ type: 'late', lecture_id: l.id, text: `محاضرة متأخرة: ${l.name}`, at: l.sent_at });
    else if (uploadLate(l) && !l.uploaded_at) out.push({ type: 'upload', lecture_id: l.id, text: `محاضرة معتمدة ومارفعتش: ${l.name}`, at: l.sent_at });
  }
  const ids = batchIds(u), lim = num('coord_reply_minutes') * 60e3, csLim = num('cs_reply_minutes') * 60e3;
  if (u.role !== 'doctor') for (const t of all(`SELECT * FROM tickets WHERE closed_at IS NULL ${ids ? `AND batch_id IN (${inList(ids)})` : ''}`)) {
    if (t.reply_at && !t.returned_at && now() - t.reply_at > lim) out.push({ type: 'ticket', ticket_id: t.id, text: `تذكرة #${t.id}: رد الدكتور مارجعش لخدمة العملاء`, at: t.reply_at });
    if (t.returned_at && !t.delivered_at && now() - t.returned_at > csLim) out.push({ type: 'ticket', ticket_id: t.id, text: `تذكرة #${t.id}: الرد ماوصلش للطالب`, at: t.returned_at });
  }
  if (u.role !== 'doctor' && u.role !== 'cs') for (const b of batchRows(u)) if (b.exam_alert) out.push({ type: 'exam', batch_id: b.id, text: `امتحان ${b.code} بعد ${b.exam_days} يوم ومفيش مراجعات`, at: 0 });
  if (u.role === 'admin') {
    for (const p of all("SELECT p.id, u.name FROM penalties p JOIN users u ON u.id=p.user_id WHERE p.status='proposed'")) out.push({ type: 'penalty', penalty_id: p.id, text: `قرار على ${p.name} مستني اعتمادك`, at: 0 });
    for (const p of all("SELECT p.id, u.name FROM penalties p JOIN users u ON u.id=p.user_id WHERE p.objection IS NOT NULL AND p.reply IS NULL")) out.push({ type: 'penalty', penalty_id: p.id, text: `${p.name} قدّم اعتراض`, at: 0 });
    for (const t of all("SELECT t.user_id, t.problem, t.problem_at, u.name FROM transfer_msgs t JOIN users u ON u.id=t.user_id WHERE t.problem IS NOT NULL AND t.confirmed_at IS NULL AND t.problem_at>?", now() - 7 * DAY)) out.push({ type: 'transfer', user_id: t.user_id, text: `${t.name}: مشكلة في التحويل · ${t.problem.slice(0, 60)}`, at: t.problem_at });
    for (const t of all("SELECT t.user_id, t.created_at, u.name FROM transfer_msgs t JOIN users u ON u.id=t.user_id WHERE t.needs_confirm=1 AND t.confirmed_at IS NULL AND t.problem IS NULL AND t.created_at<? AND t.created_at>?", now() - DAY, now() - 14 * DAY)) out.push({ type: 'transfer', user_id: t.user_id, text: `${t.name} لسه ماأكدش استلام التحويل`, at: t.created_at });
    for (const a of all("SELECT a.user_id, a.detail, a.at, u.name FROM audit a JOIN users u ON u.id=a.user_id WHERE a.action='profile_change' AND a.at>? ORDER BY a.at DESC LIMIT 20", now() - 3 * DAY)) out.push({ type: 'profile', user_id: a.user_id, text: `${a.name} ${JSON.parse(a.detail || '{}').what || 'غيّر بياناته'}`, at: a.at });
  }
  return out.sort((a, b) => a.at - b.at);
}
const fmtDur = ms => { if (ms == null) return '—'; const h = Math.floor(ms / H), m = Math.round((ms % H) / 60e3); return h ? `${h}س ${m}د` : `${m}د`; };
function aiPrompt(t = now()) {
  const admin = { role: 'admin', id: 0 }, s = daySummary(admin, t), y = daySummary(admin, t - DAY);
  const L = []; const brand = setting('brand');
  L.push(`أنت محلل عمليات لأكاديمية ${brand} لشرح المحاضرات الطبية لطلبة جامعات سعودية.`, `حلّل بيانات يوم ${dayStr(t)} وقارنها بأمس.`, '');
  L.push('[الملخص العام] (النهارده / أمس)');
  L.push(`محاضرات اتبعتت: ${s.sent} / ${y.sent} | فيديوهات اتسلمت: ${s.videos} / ${y.videos} | ملفات أسئلة: ${s.qfiles} / ${y.qfiles} | اترفعت: ${s.uploaded} / ${y.uploaded}`);
  L.push(`متأخرة الآن: ${s.lateNow} | قيد التنفيذ: ${s.progress} | مستنية رفع: ${s.toUpload}`);
  L.push(`أسئلة جديدة: ${s.questions} / ${y.questions} | تذاكر عدّت المهلة: ${s.ticketsLate} | مشاكل جديدة: ${s.problemsNew} | اتحلت: ${s.problemsClosed} | مفتوحة: ${s.problemsOpen}`, '');
  L.push('[الدفعات] الكود | الجامعة | المسؤول | الاشتراكات (آخر قراءة / اللي قبلها / المتوقع) | متأخر | مشاكل مفتوحة | محاضرات | مراجعات | أقرب امتحان');
  for (const b of batchRows(admin)) L.push(`${b.code} | ${b.uni} ${b.year} | ${b.coordinator || '—'} | ${b.subs ?? '—'} / ${b.subs_prev ?? '—'} / ${b.expected_subs || '—'} | ${b.lateNow} | ${b.problems} | ${b.lectures} | ${b.revisions} | ${b.exam_date ? `${b.exam_date} (بعد ${b.exam_days} يوم)` : '—'}`);
  L.push('', '[الدكاترة] الاسم | اتبعتله النهارده | الطاقة | متأخر الآن | أيام تقصير (30 يوم) | الالتزام | التقييم | متوسط تسليم الفيديو');
  for (const d of all("SELECT id, name FROM users WHERE role='doctor' AND active=1")) { const x = doctorStats(d.id); if (!x.assigned) continue; L.push(`${d.name} | ${x.sentToday} | ${x.capacity} | ${x.lateNow} | ${x.shortDays} | ${Math.round(x.compliance * 100)}% | ${x.score.total} | ${fmtDur(x.avgVideo)}`); }
  L.push('', '[مسؤولين الدفعات] الاسم | ردود اتأخرت | رفع اتأخر | مشاكل مفتوحة | إنجاز الليستة النهارده | التقييم');
  for (const c of all("SELECT id, name FROM users WHERE role='coordinator' AND active=1")) { const x = coordinatorStats(c.id); const done = (one('SELECT COUNT(*) n FROM checklist WHERE user_id=? AND period=? AND done=1', c.id, dayStr(t)) || {}).n; L.push(`${c.name} | ${x.replyLate} | ${x.uploadLate} | ${x.openProblems} | ${done}/${Object.keys(DAILY).length} | ${x.score.total}`); }
  L.push('', '[خدمة العملاء] الاسم | تذاكر اتعاملت معاها | اتأخرت | الالتزام');
  for (const c of all("SELECT id, name FROM users WHERE role='cs' AND active=1")) { const x = csStats(c.id); L.push(`${c.name} | ${x.handled} | ${x.late} | ${x.score}%`); }
  L.push('', '[تقارير المشرفين]');
  for (const r of all("SELECT u.name, r.body FROM reports r JOIN users u ON u.id=r.user_id WHERE u.role='supervisor' AND r.day=?", dayStr(t))) L.push(`- ${r.name}: ${r.body}`);
  L.push('', 'المطلوب:', '1. أهم 3 حاجات حصلت النهارده.', '2. الاتجاهات: إيه اللي بيتحسن وإيه اللي بيسوء.', '3. المخاطر الجاية: امتحانات قربت ومفيش مراجعات، دفعات اشتراكاتها تحت المتوقع، دكاترة تأخيرهم بيتكرر.', '4. مين محتاج تدخل مني، بالاسم والسبب.', '5. من 3 لـ 5 إجراءات محددة أعملها بكرة.', '', 'القواعد: اعتمد على الأرقام اللي فوق بس، ولو فيه بيانات ناقصة قول. اكتب باختصار وبالعامية المصرية.');
  return L.join('\n');
}
/* ---------- auto daily report ---------- */
function dailyReport(u, t = now()) {
  const t0 = dayStart(t), t1 = t0 + DAY, T = Math.min(t1, now()), D = deadline(), day = dayStr(t);
  const ids = batchIds(u), bw = ids ? `batch_id IN (${inList(ids)})` : '1=1';
  const names = Object.fromEntries(all('SELECT id, name FROM users').map(x => [x.id, x.name]));
  const bmap = Object.fromEntries(all('SELECT id, code, coordinator_id, supervisor_id FROM batches').map(b => [b.id, b]));
  const who = bid => { const b = bmap[bid] || {}; return { batch_code: b.code || '', coordinator: names[b.coordinator_id] || '—', supervisor: names[b.supervisor_id] || '—' }; };
  const late = [];
  for (const l of all(`SELECT * FROM lectures WHERE ${bw} AND sent_at<? AND excused=0`, T - D)) {
    const vMiss = !l.video_at || l.video_at > T, qMiss = !l.no_q && (!l.q_at || l.q_at > T);
    if (!vMiss && !qMiss) continue;
    late.push({ id: l.id, name: l.name, type: l.type, priority: l.priority, since: l.sent_at + D, late_ms: T - l.sent_at - D, missing: [vMiss && 'الفيديو', qMiss && 'ملف الأسئلة'].filter(Boolean), doctor: names[l.doctor_id] || '—', ...who(l.batch_id) });
  }
  late.sort((a, b) => a.since - b.since);
  const lim = num('coord_reply_minutes') * 60e3, csLim = num('cs_reply_minutes') * 60e3, before = x => x && x < T;
  const tk = all(`SELECT * FROM tickets WHERE ${bw} AND created_at<? AND (closed_at IS NULL OR closed_at>=?)`, T, T);
  const problems = tk.filter(x => x.kind === 'problem').map(x => ({ id: x.id, body: x.body.slice(0, 160), student: x.student, age_ms: T - x.created_at, created_at: x.created_at, ...who(x.batch_id) })).sort((a, b) => b.age_ms - a.age_ms);
  const lateQ = [], waitingDoctor = [];
  for (const x of tk.filter(x => x.kind === 'question')) {
    const base = { id: x.id, body: x.body.slice(0, 160), student: x.student, ...who(x.batch_id), doctor: names[x.doctor_id] || null };
    if (!before(x.sent_doctor_at)) { if (T - x.created_at > lim) lateQ.push({ ...base, stage: 'لسه مااتبعتش للدكتور', owner: base.coordinator, late_ms: T - x.created_at - lim }); }
    else if (!before(x.reply_at)) waitingDoctor.push({ ...base, age_ms: T - x.sent_doctor_at });
    else if (!before(x.returned_at)) { if (T - x.reply_at > lim) lateQ.push({ ...base, stage: 'الدكتور رد ومارجعش لخدمة العملاء', owner: base.coordinator, late_ms: T - x.reply_at - lim }); }
    else if (T - x.returned_at > csLim) lateQ.push({ ...base, stage: 'الرد ماوصلش للطالب', owner: 'خدمة العملاء', late_ms: T - x.returned_at - csLim });
  }
  lateQ.sort((a, b) => b.late_ms - a.late_ms); waitingDoctor.sort((a, b) => b.age_ms - a.age_ms);
  // team: what's missing today
  const team = [], lastDayOfWeek = new Date(day + 'T12:00:00Z').getUTCDay() === 5; // Friday ends the Sat-Fri week
  const coords = u.role === 'supervisor' ? all("SELECT DISTINCT u.id, u.name FROM batches b JOIN users u ON u.id=b.coordinator_id WHERE b.supervisor_id=? AND u.active=1", u.id) : all("SELECT id, name FROM users WHERE role='coordinator' AND active=1 ORDER BY name");
  for (const c of coords) {
    const done = new Set(all('SELECT item FROM checklist WHERE user_id=? AND done=1 AND period IN (?,?)', c.id, day, weekStr(t)).map(r => r.item));
    let miss = Object.entries(DAILY).filter(([k]) => !done.has(k)).map(([, v]) => v);
    if (miss.length === Object.keys(DAILY).length) miss = [`ماعلّمش على أي مهمة من الـ${miss.length} النهارده`];
    if (lastDayOfWeek) for (const [k, v] of Object.entries(WEEKLY)) if (!done.has(k)) miss.push(v + ' (أسبوعي)');
    team.push({ id: c.id, name: c.name, role: 'coordinator', missing: miss, total: Object.keys(DAILY).length, done: Object.keys(DAILY).filter(k => done.has(k)).length });
  }
  if (u.role === 'admin') {
    for (const s of all("SELECT id, name FROM users WHERE role='supervisor' AND active=1 ORDER BY name")) {
      const has = one('SELECT 1 FROM reports WHERE user_id=? AND day=?', s.id, day);
      team.push({ id: s.id, name: s.name, role: 'supervisor', missing: has ? [] : ['التقرير اليومي'], total: 1, done: has ? 1 : 0 });
    }
    const stale = all('SELECT b.code, (SELECT MAX(day) FROM subs s WHERE s.batch_id=b.id) last FROM batches b WHERE b.active=1').filter(b => !b.last || (Date.parse(day + 'T00:00:00Z') - Date.parse(b.last + 'T00:00:00Z')) / DAY > 7);
    team.push({ id: 0, name: 'خدمة العملاء', role: 'cs', missing: stale.length ? [`تسجيل اشتراكات ${stale.length} دفعة عدّى عليها أكتر من 7 أيام${stale.length <= 6 ? ` (${stale.map(b => b.code).join('، ')})` : ''}`] : [], total: 1, done: stale.length ? 0 : 1 });
  }
  // delivered today
  const dl = all(`SELECT * FROM lectures WHERE ${bw} AND video_at IS NOT NULL AND q_at IS NOT NULL AND MAX(video_at,q_at)>=? AND MAX(video_at,q_at)<?`, t0, t1)
    .map(l => ({ id: l.id, name: l.name, type: l.type, price: l.price, doctor: names[l.doctor_id] || '—', batch_code: (bmap[l.batch_id] || {}).code, late: isLate(l.video_at, l.sent_at, l.excused) || isLate(l.q_at, l.sent_at, l.excused) }));
  const byType = {}; for (const l of dl) { const x = (byType[l.type] ||= { n: 0, sum: 0 }); x.n++; x.sum += l.price; }
  return { day, at: T, late, problems, lateQ, waitingDoctor, team, delivered: { n: dl.length, total: dl.reduce((s, l) => s + l.price, 0), byType, list: dl } };
}
function dailyReportText(r, brand = setting('brand')) {
  const m = n => (Math.round(n * 100) / 100).toLocaleString('en-US'), cap = (arr, n, f) => [...arr.slice(0, n).map(f), ...(arr.length > n ? [`… و${arr.length - n} كمان في اللوحة`] : [])];
  const L = [`📋 تقرير ${brand} اليومي · ${r.day}`, ''];
  L.push(`✅ اتشرح النهارده: ${r.delivered.n} محاضرة · الإجمالي ${m(r.delivered.total)}`);
  for (const [t, x] of Object.entries(r.delivered.byType)) L.push(`   ${TYPES[t]}: ${x.n} = ${m(x.sum)}`);
  L.push('', `⏰ محاضرات متأخرة: ${r.late.length}`);
  L.push(...cap(r.late, 15, l => `• #${l.id} ${l.name} · دفعة ${l.batch_code}\n   متأخرة من ${fmtDur(l.late_ms)} · ناقص ${l.missing.join(' و')}\n   د. ${l.doctor} · المسؤول: ${l.coordinator} · المشرف: ${l.supervisor}`));
  L.push('', `❗ مشاكل مفتوحة: ${r.problems.length}`);
  L.push(...cap(r.problems, 10, p => `• #${p.id} دفعة ${p.batch_code} · مفتوحة من ${fmtDur(p.age_ms)} · ${p.coordinator}\n   ${p.body.slice(0, 80)}`));
  L.push('', `💬 أسئلة متأخرة: ${r.lateQ.length}${r.waitingDoctor.length ? ` · مستنية رد الدكتور: ${r.waitingDoctor.length}` : ''}`);
  L.push(...cap(r.lateQ, 10, q => `• #${q.id} دفعة ${q.batch_code} · ${q.stage} · متأخر ${fmtDur(q.late_ms)} · على: ${q.owner}`));
  const miss = r.team.filter(x => x.missing.length);
  L.push('', `📝 التاسكات الناقصة: ${miss.length ? `${miss.length} من التيم` : 'التيم كله خلّص ✓'}`);
  for (const x of miss) L.push(`• ${x.name}: ${x.missing.join('، ')}`);
  return L.join('\n').slice(0, 4000);
}
function coordinatorReport(id, day = dayStr()) {
  const items = all('SELECT item, done, note FROM checklist WHERE user_id=? AND period IN (?,?)', id, day, weekStr(Date.parse(day + 'T12:00:00Z')));
  const map = Object.fromEntries(items.map(i => [i.item, i]));
  return { day, items: [...Object.entries(DAILY), ...Object.entries(WEEKLY)].map(([k, label]) => ({ key: k, label, weekly: !!WEEKLY[k], done: !!map[k]?.done, note: map[k]?.note || '' })), summary: daySummary({ role: 'coordinator', id }, Date.parse(day + 'T12:00:00Z')) };
}

module.exports = { PRIORITY, monthWin, H, DAY, now, TYPES, DAILY, WEEKLY, dayStr, weekStr, dayStart, localHM, TZ, deadline, batchIds, inList, scopedLectures, scopedDoctorIds, fileState, isLate, delivered, lectureState, uploadLate, decorate,
  doctorStats, coordinatorStats, supervisorStats, csStats, payable, daySummary, batchRows, alerts, aiPrompt, coordinatorReport, fmtDur, latestSubs, dailyReport, dailyReportText };
