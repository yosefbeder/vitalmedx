'use strict';
const { one, all, num, setting } = require('./db');

const H = 3600e3, DAY = 864e5;
const now = () => Date.now();
const deadline = () => num('deadline_hours') * H;
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
function fileState(at, ok, sent) {
  if (!at) return now() - sent > deadline() ? 'overdue' : 'pending';
  return ok ? 'approved' : 'review';
}
const isLate = (at, sent) => (at ? at - sent > deadline() : now() - sent > deadline());
const delivered = l => !!(l.video_at && l.q_at);
const deliveredAt = l => (delivered(l) ? Math.max(l.video_at, l.q_at) : null);
function lectureState(l) {
  const a = fileState(l.video_at, l.video_ok_at, l.sent_at), b = fileState(l.q_at, l.q_ok_at, l.sent_at);
  if (a === 'overdue' || b === 'overdue') return 'late';
  if (a === 'pending' || b === 'pending') return 'progress';
  if (!(l.video_ok_at && l.q_ok_at)) return 'review';
  return l.uploaded_at ? 'done' : 'upload';
}
const uploadLate = l => { const d = l.video_ok_at && l.q_ok_at ? Math.max(l.video_ok_at, l.q_ok_at) : null; if (!d) return false; const lim = num('upload_minutes') * 60e3; return l.uploaded_at ? l.uploaded_at - d > lim : now() - d > lim; };
function decorate(l) {
  const b = one('SELECT b.code, b.year, u.name uni FROM batches b JOIN universities u ON u.id=b.university_id WHERE b.id=?', l.batch_id) || {};
  const d = one('SELECT name FROM users WHERE id=?', l.doctor_id) || {}, c = one('SELECT name FROM users WHERE id=?', l.coordinator_id) || {};
  return { ...l, batch_code: b.code, batch_year: b.year, university: b.uni, doctor: d.name, coordinator: c.name, state: lectureState(l),
    v_state: fileState(l.video_at, l.video_ok_at, l.sent_at), q_state: fileState(l.q_at, l.q_ok_at, l.sent_at),
    v_late: isLate(l.video_at, l.sent_at), q_late: isLate(l.q_at, l.sent_at), upload_late: uploadLate(l), deadline_at: l.sent_at + deadline() };
}

/* ---------- doctors ---------- */
function doctorStats(id) {
  const ls = all('SELECT * FROM lectures WHERE doctor_id=?', id);
  const doc = one('SELECT * FROM doctors WHERE user_id=?', id) || { capacity: 3, adj: 0 };
  let due = 0, onTime = 0, lateEver = 0, lateNow = 0, deliveredN = 0; const vT = [], qT = [];
  const t0 = dayStart(), m0 = now() - 30 * DAY; let today = 0, month = 0;
  for (const l of ls) {
    for (const [at, arr] of [[l.video_at, vT], [l.q_at, qT]]) {
      if (fileState(at, 1, l.sent_at) !== 'pending') { due++; if (!isLate(at, l.sent_at)) onTime++; }
      if (at) arr.push(at - l.sent_at);
    }
    if (isLate(l.video_at, l.sent_at) || isLate(l.q_at, l.sent_at)) lateEver++;
    if (lectureState(l) === 'late') lateNow++;
    if (delivered(l)) { deliveredN++; const d = deliveredAt(l); if (d >= t0) today++; if (d >= m0) month++; }
  }
  // capacity shortfall: days in last 30 where lectures sent within capacity weren't delivered on time
  const byDay = {};
  for (const l of ls) if (l.sent_at >= m0 && now() - l.sent_at > deadline()) (byDay[dayStr(l.sent_at)] ||= []).push(l);
  let shortDays = 0;
  for (const arr of Object.values(byDay)) { const capped = arr.sort((a, b) => a.sent_at - b.sent_at).slice(0, doc.capacity); if (capped.some(l => isLate(l.video_at, l.sent_at) || isLate(l.q_at, l.sent_at))) shortDays++; }
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
function subsRatio(bids) {
  const rs = [];
  for (const id of bids) { const b = one('SELECT expected_subs FROM batches WHERE id=?', id); const s = latestSubs(id)[0]; if (b && b.expected_subs > 0 && s) rs.push(clamp(s.count / b.expected_subs, 0, 1)); }
  return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 1;
}

/* ---------- team ratings ---------- */
function coordinatorStats(id) {
  const bids = all('SELECT id FROM batches WHERE coordinator_id=?', id).map(r => r.id), m0 = now() - 30 * DAY;
  const tk = all(`SELECT * FROM tickets WHERE batch_id IN (${inList(bids)}) AND created_at>=?`, m0);
  const lim = num('coord_reply_minutes') * 60e3;
  const rep = tk.filter(t => t.reply_at), repOk = rep.filter(t => (t.returned_at || now()) - t.reply_at <= lim);
  const ls = all(`SELECT * FROM lectures WHERE batch_id IN (${inList(bids)}) AND sent_at>=?`, m0).filter(l => l.video_ok_at && l.q_ok_at);
  const upOk = ls.filter(l => !uploadLate(l));
  const probs = tk.filter(t => t.kind === 'problem'), probsClosed = probs.filter(t => t.closed_at);
  const days = 7, items = Object.keys(DAILY).length * days;
  const done = (one(`SELECT COUNT(*) n FROM checklist WHERE user_id=? AND done=1 AND period>=? AND period NOT LIKE 'W%'`, id, dayStr(now() - (days - 1) * DAY)) || {}).n;
  const s = { subs: 30 * subsRatio(bids), deadlines: 30 * ratio(repOk.length + upOk.length, rep.length + ls.length), problems: 20 * ratio(probsClosed.length, probs.length), checklist: 20 * clamp(done / items, 0, 1) };
  s.total = Math.round(s.subs + s.deadlines + s.problems + s.checklist);
  return { batches: bids.length, replyLate: rep.length - repOk.length, uploadLate: ls.length - upOk.length, openProblems: probs.length - probsClosed.length, score: s };
}
function supervisorStats(id) {
  const bids = all('SELECT id FROM batches WHERE supervisor_id=?', id).map(r => r.id), m0 = now() - 30 * DAY;
  const ls = all(`SELECT * FROM lectures WHERE batch_id IN (${inList(bids)}) AND sent_at>=?`, m0);
  let due = 0, ok = 0; for (const l of ls) for (const at of [l.video_at, l.q_at]) if (fileState(at, 1, l.sent_at) !== 'pending') { due++; if (!isLate(at, l.sent_at)) ok++; }
  const appr = ls.filter(l => l.video_ok_at && l.q_ok_at); const up = appr.filter(l => !uploadLate(l));
  const probs = all(`SELECT * FROM tickets WHERE kind='problem' AND batch_id IN (${inList(bids)}) AND created_at>=?`, m0);
  const open = probs.filter(p => !p.closed_at).length;
  const reps = (one('SELECT COUNT(*) n FROM reports WHERE user_id=? AND day>=?', id, dayStr(now() - 6 * DAY)) || {}).n;
  const s = { subs: 40 * subsRatio(bids), delays: 30 * ratio(ok + up.length, due + appr.length), problems: 20 * (1 - ratio(open, probs.length, 0)), reports: 10 * clamp(reps / 7, 0, 1) };
  s.total = Math.round(s.subs + s.delays + s.problems + s.reports);
  return { batches: bids.length, openProblems: open, lateNow: ls.filter(l => lectureState(l) === 'late').length, score: s };
}
function csStats(id) {
  const lim = num('cs_reply_minutes') * 60e3, m0 = now() - 30 * DAY;
  const tk = all('SELECT * FROM tickets WHERE returned_at IS NOT NULL AND returned_at>=?', m0);
  const mine = tk.filter(t => t.delivered_by === id || (!t.delivered_by && t.created_by === id));
  const ok = mine.filter(t => t.delivered_at && t.delivered_at - t.returned_at <= lim);
  return { handled: mine.length, late: mine.length - ok.length, created: (one('SELECT COUNT(*) n FROM tickets WHERE created_by=? AND created_at>=?', id, m0) || {}).n, score: Math.round(100 * ratio(ok.length, mine.length)) };
}

/* ---------- finance ---------- */
function payable(userId, until = now()) {
  const u = one('SELECT id, role, salary FROM users WHERE id=?', userId);
  const lecs = u.role === 'doctor' ? all('SELECT id, name, type, price, batch_id, sent_at, video_at, q_at FROM lectures WHERE doctor_id=? AND settlement_id IS NULL AND video_at IS NOT NULL AND q_at IS NOT NULL AND MAX(video_at,q_at)<=?', userId, until) : [];
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
    sent: ls.filter(l => inDay(l.sent_at)).length, videos: ls.filter(l => inDay(l.video_at)).length, qfiles: ls.filter(l => inDay(l.q_at)).length,
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
        revisions, qfiles: ls.filter(l => l.q_at).length, lateNow: ls.filter(l => lectureState(l) === 'late').length,
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
function coordinatorReport(id, day = dayStr()) {
  const items = all('SELECT item, done, note FROM checklist WHERE user_id=? AND period IN (?,?)', id, day, weekStr(Date.parse(day + 'T12:00:00Z')));
  const map = Object.fromEntries(items.map(i => [i.item, i]));
  return { day, items: [...Object.entries(DAILY), ...Object.entries(WEEKLY)].map(([k, label]) => ({ key: k, label, weekly: !!WEEKLY[k], done: !!map[k]?.done, note: map[k]?.note || '' })), summary: daySummary({ role: 'coordinator', id }, Date.parse(day + 'T12:00:00Z')) };
}

module.exports = { H, DAY, now, TYPES, DAILY, WEEKLY, dayStr, weekStr, dayStart, localHM, TZ, deadline, batchIds, inList, scopedLectures, scopedDoctorIds, fileState, isLate, delivered, lectureState, uploadLate, decorate,
  doctorStats, coordinatorStats, supervisorStats, csStats, payable, daySummary, batchRows, alerts, aiPrompt, coordinatorReport, fmtDur, latestSubs };
