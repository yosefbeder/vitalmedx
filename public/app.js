'use strict';
{
/* ================= helpers ================= */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const H = 36e5;
const fmt = t => { if (!t) return '—'; const d = new Date(t); return d.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); };
const dur = ms => { if (ms == null || isNaN(ms)) return '—'; ms = Math.max(0, ms); const h = Math.floor(ms / H), m = Math.floor(ms % H / 6e4); return h >= 48 ? `${Math.floor(h / 24)} يوم ${h % 24}س` : h ? `${h}س ${m}د` : `${m}د`; };
const money = n => (Math.round((n || 0) * 100) / 100).toLocaleString('en-US');
const pct = x => Math.round((x || 0) * 100) + '%';
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2800); };
const opts = (list, sel, all) => (all != null ? `<option value="">${esc(all)}</option>` : '') + list.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(sel ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('');
const kpi = (n, l, bad) => `<div class="kpi${bad ? ' bad' : ''}"><b>${esc(n)}</b><span>${esc(l)}</span></div>`;
const meter = (l, v, max, txt) => `<div class="meter"><span>${l}</span><div><i style="width:${max ? Math.max(0, Math.min(100, v / max * 100)) : 0}%"></i></div><b class="n">${esc(txt ?? v)}</b></div>`;
const pill = (t, c) => `<span class="p ${c}">${esc(t)}</span>`;
const empty = t => `<div class="empty">${esc(t)}</div>`;
async function api(method, url, body) {
  const o = { method, headers: { 'x-requested-with': 'vm' } };
  if (body instanceof FormData) o.body = body; else if (body) { o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
  const r = await fetch(url, o); let j = {}; try { j = await r.json(); } catch {}
  if (r.status === 401 && url !== '/api/login') { showLogin(); throw new Error(j.error || 'سجل دخول'); }
  if (!r.ok) { toast(j.error || 'حصل خطأ'); throw new Error(j.error || 'error'); }
  return j;
}
const dlg = $('#dlg');
const modal = (title, body) => { $('#dlgc').innerHTML = `<div class="dh"><div>${title}</div><button class="btn g sm" data-close>إغلاق</button></div><div class="db">${body}</div>`; if (!dlg.open) dlg.showModal(); };
dlg.addEventListener('click', e => { if (e.target.closest('[data-close]') || e.target === dlg) dlg.close(); });
new MutationObserver(() => { for (const c of document.querySelectorAll('.stack td:not([data-l])')) { let i = 0, p = c; while ((p = p.previousElementSibling)) i += p.colSpan; c.dataset.l = c.closest('table').rows[0].cells[i]?.textContent || ''; } }).observe(document, { childList: true, subtree: true });

/* ================= state ================= */
let ME = null, view = 'home', cache = {};
const ROLE = { admin: 'أدمن', supervisor: 'مشرف', coordinator: 'مسؤول دفعة', cs: 'خدمة عملاء', doctor: 'دكتور' };
const NAV = {
  admin: [['home', 'لوحة التحكم'], ['unis', 'الجامعات'], ['lectures', 'المحاضرات'], ['tickets', 'الأسئلة والمشاكل'], ['doctors', 'الدكاترة'], ['team', 'الفريق'], ['reports', 'التقارير'], ['penalties', 'العقوبات'], ['finance', 'الحسابات'], ['subs', 'الاشتراكات'], ['settings', 'الإعدادات'], ['account', 'حسابي']],
  supervisor: [['home', 'لوحة التحكم'], ['unis', 'دفعاتي'], ['lectures', 'المحاضرات'], ['tickets', 'الأسئلة والمشاكل'], ['doctors', 'الدكاترة'], ['team', 'التيم'], ['reports', 'التقرير اليومي'], ['penalties', 'العقوبات'], ['account', 'حسابي']],
  coordinator: [['home', 'لوحة التحكم'], ['checklist', 'مهام اليوم'], ['lectures', 'المحاضرات'], ['tickets', 'الأسئلة والمشاكل'], ['unis', 'دفعاتي'], ['doctors', 'الدكاترة'], ['penalties', 'العقوبات'], ['account', 'حسابي']],
  cs: [['tickets', 'التذاكر'], ['subs', 'الاشتراكات'], ['shift', 'الشيفت'], ['account', 'حسابي']],
  doctor: [['home', 'مهامي'], ['penalties', 'القرارات'], ['account', 'حسابي']],
};
const TY = () => ME.types;
const LS = { late: ['متأخرة', 'bad'], progress: ['قيد التنفيذ', 'pd'], review: ['تحت المراجعة', 'rv'], upload: ['مستنية رفع', 'warn'], done: ['مكتملة', 'ok'] };
const FS = { pending: ['قيد التنفيذ', 'pd'], overdue: ['متأخر – لم يُسلَّم', 'bad'], review: ['تحت المراجعة', 'rv'], approved: ['معتمد', 'ok'] };
function fcell(l, k) {
  const st = l[k + '_state'], at = k === 'v' ? l.video_at : l.q_at; let sub;
  if (st === 'pending') sub = 'باقي ' + dur(l.deadline_at - Date.now());
  else if (st === 'overdue') sub = `<span class="red">متأخر ${dur(Date.now() - l.deadline_at)}</span>`;
  else sub = (l[k + '_late'] ? '<span class="red">اتسلم متأخر</span>' : 'في الموعد') + ' · ' + dur(at - l.sent_at);
  return pill(...FS[st]) + `<div class="mut">${sub}</div>`;
}

/* ================= boot ================= */
function showLogin() { ME = null; $('#app').hidden = true; $('#login').hidden = false; }
$('#lf').addEventListener('submit', async e => {
  e.preventDefault(); const f = new FormData(e.target); $('#lerr').textContent = '';
  try { await api('POST', '/api/login', { email: f.get('email'), pass: f.get('pass') }); await boot(); } catch (err) { $('#lerr').textContent = err.message; }
});
$('#logout').onclick = async () => { await api('POST', '/api/logout'); showLogin(); };
$('#bell').onclick = () => openAlerts();
async function boot() {
  try { ME = await api('GET', '/api/me'); } catch { return showLogin(); }
  document.querySelectorAll('.brandname').forEach(b => (b.textContent = ME.brand)); document.title = ME.brand;
  $('#login').hidden = true; $('#app').hidden = false;
  const h = location.hash.slice(1); view = NAV[ME.role].some(n => n[0] === h) ? h : NAV[ME.role][0][0];
  $('#mebox').innerHTML = `<b>${esc(ME.name)}</b><small>${ROLE[ME.role]}</small>`;
  render();
}
addEventListener('hashchange', () => { if (!ME) return; const h = location.hash.slice(1); if (NAV[ME.role].some(n => n[0] === h)) { view = h; render(); } });
async function render() {
  $('#nav').innerHTML = NAV[ME.role].map(([k, l]) => `<a href="#${k}" class="${k === view ? 'on' : ''}">${l}</a>`).join('');
  $('#crumb').textContent = NAV[ME.role].find(n => n[0] === view)[1];
  $('#main').innerHTML = '<div class="empty">بيحمّل…</div>';
  try { await V[view](); } catch (e) { if (ME) $('#main').innerHTML = empty('حصل خطأ: ' + e.message); }
  refreshBell();
}
async function refreshBell() { if (ME.role === 'cs') { $('#bell').hidden = true; return; } try { const h = await api('GET', '/api/home'); cache.alerts = h.alerts; $('#bell').innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>' + (h.alerts.length ? `<span>${h.alerts.length}</span>` : ''); } catch {} }
function alertRows(list) {
  return list.length ? `<table class="stack"><tbody>${list.map(a => `<tr><td>${esc(a.text)}</td><td class="n">${a.lecture_id ? `<button class="btn g sm" data-lec="${a.lecture_id}">فتح</button>` : a.ticket_id ? `<button class="btn g sm" data-tk="${a.ticket_id}">فتح</button>` : a.penalty_id ? '<a class="btn g sm" href="#penalties" data-close style="display:inline-flex;align-items:center;text-decoration:none">عرض</a>' : ''}</td></tr>`).join('')}</tbody></table>` : empty('مفيش تنبيهات');
}
function openAlerts() { modal(`<b>التنبيهات (${(cache.alerts || []).length})</b>`, alertRows(cache.alerts || [])); }
document.addEventListener('click', e => {
  const l = e.target.closest('[data-lec]'); if (l) { openLecture(Number(l.dataset.lec)); return; }
  const t = e.target.closest('[data-tk]'); if (t) { openTicket(Number(t.dataset.tk)); return; }
  const d = e.target.closest('[data-doc]'); if (d) { openDoctor(Number(d.dataset.doc)); }
});

/* ================= views ================= */
const V = {};

V.home = async () => {
  const h = await api('GET', '/api/home');
  if (ME.role === 'doctor') return doctorHome(h);
  const s = h.summary, late = s.lateNow;
  let html = `<h2>${late ? `${late} محاضرة متأخرة دلوقتي محتاجة متابعة` : 'كل المحاضرات ماشية في مواعيدها'}</h2><p class="note">أرقام النهارده · ${esc(ME.today)}</p>
  <div class="kpis">${kpi(s.sent, 'اتبعتت النهارده')}${kpi(s.videos, 'فيديوهات اتسلمت')}${kpi(s.qfiles, 'ملفات أسئلة اتسلمت')}${kpi(s.uploaded, 'اترفعت')}${kpi(late, 'متأخرة الآن', late)}${kpi(s.toUpload, 'مستنية رفع', s.toUpload)}${kpi(s.questions, 'أسئلة جديدة')}${kpi(s.ticketsLate, 'تذاكر عدّت المهلة', s.ticketsLate)}${kpi(s.problemsOpen, 'مشاكل مفتوحة', s.problemsOpen)}</div>`;
  if (h.mine) html += myScore(h.mine);
  html += `<div class="grid2"><section class="panel"><h3>تنبيهات تحتاج متابعة</h3>${alertRows(h.alerts.slice(0, 15))}</section>`;
  if (h.days) { const mx = Math.max(1, ...h.days.map(d => d.sent));
    html += `<section class="panel"><h3>المحاضرات المرسلة آخر 14 يوم</h3><div class="bars">${h.days.map(d => `<div class="bar" title="${d.day}: ${d.sent}"><i class="a" style="height:${d.ontime / mx * 100}%"></i><i class="b" style="height:${d.late / mx * 100}%"></i><i class="c" style="height:${Math.max(0, d.sent - d.ontime - d.late) / mx * 100}%"></i></div>`).join('')}</div><div class="blab">${h.days.map((d, i) => `<span>${i % 2 ? '' : d.day.slice(8)}</span>`).join('')}</div><div class="legend"><span><i style="background:var(--accent)"></i>في الموعد</span><span><i style="background:var(--red)"></i>فيها تأخير</span><span><i style="background:var(--line)"></i>جارية</span></div></section>`;
  } else html += `<section class="panel"><h3>دفعاتي</h3>${batchTable(h.batches, true)}</section>`;
  html += '</div>';
  $('#main').innerHTML = html;
};
function myScore(m) {
  const s = m.score; if (typeof s === 'number') return `<div class="panel"><h3>تقييمك: ${s}%</h3><p class="mut">نسبة الردود اللي اتوصلت للطالب في مهلة النص ساعة آخر 30 يوم · اتعاملت مع ${m.handled} تذكرة</p></div>`;
  const parts = ME.role === 'coordinator' ? [['الاشتراكات', s.subs, 30], ['مهل الأسئلة والرفع', s.deadlines, 30], ['المشاكل والتنظيم', s.problems, 20], ['ليستة المهام', s.checklist, 20]] : [['الاشتراكات', s.subs, 40], ['التقصير والتأخير', s.delays, 30], ['المشاكل المفتوحة', s.problems, 20], ['التقرير اليومي', s.reports, 10]];
  return `<div class="panel"><div class="row sp"><h3>تقييمك آخر 30 يوم</h3><b style="font-size:28px">${s.total}<span class="mut"> / 100</span></b></div>${parts.map(([l, v, m]) => meter(l, v, m, `${Math.round(v)}/${m}`)).join('')}</div>`;
}
function doctorHome(h) {
  const s = h.stats, sc = s.score;
  $('#main').innerHTML = `<h2>أهلاً ${esc(ME.name)}</h2><p class="note">المحاضرات بتوصلك وبتسلّمها على البوت. هنا تقدر تتابع مهامك وتقييمك.</p>
  <div class="kpis">${kpi(sc.total, 'تقييمك من 100', sc.total < 70)}${kpi(s.assigned, 'كل المحاضرات')}${kpi(s.delivered, 'سلّمتها')}${kpi(s.lateNow, 'متأخرة الآن', s.lateNow)}${kpi(pct(s.compliance), 'التزامك بالمواعيد')}${kpi(`${s.sentToday}/${s.capacity}`, 'النهارده من طاقتك')}</div>
  <div class="grid2"><section class="panel"><h3>المحاضرات المفتوحة</h3><div id="dl"></div></section><section class="panel"><h3>تفاصيل التقييم</h3>${meter('الالتزام بالموعد', sc.dl, 35, `${Math.round(sc.dl)}/35`)}${meter('جودة الفيديو', sc.video ?? 0, 40, sc.video == null ? '—' : `${Math.round(sc.video)}/40`)}${meter('جودة الأسئلة', sc.q ?? 0, 10, sc.q == null ? '—' : `${Math.round(sc.q)}/10`)}${meter('التعليمات', sc.instr ?? 0, 10, sc.instr == null ? '—' : `${Math.round(sc.instr)}/10`)}${meter('التواصل', sc.comm ?? 0, 5, sc.comm == null ? '—' : `${Math.round(sc.comm)}/5`)}<p class="mut">${ME.linked ? 'حسابك مربوط بالبوت ✓' : 'حسابك لسه مش مربوط بالبوت. ادخل "حسابي" وخد الكود.'}</p></section></div>
  <section class="panel"><h3>آخر المحاضرات</h3><div id="dall"></div></section>`;
  api('GET', '/api/lectures?limit=60').then(ls => {
    const open = ls.filter(l => !(l.video_at && l.q_at));
    $('#dl').innerHTML = open.length ? `<table class="stack"><thead><tr><th>المحاضرة</th><th>الفيديو</th><th>الأسئلة</th></tr></thead><tbody>${open.map(l => `<tr><td>#${l.id} ${esc(l.name)}<div class="mut">${TY()[l.type]} · ${money(l.price)}</div></td><td>${fcell(l, 'v')}</td><td>${fcell(l, 'q')}</td></tr>`).join('')}</tbody></table>` : empty('مفيش محاضرات مفتوحة ✓');
    $('#dall').innerHTML = `<table class="stack"><thead><tr><th>المحاضرة</th><th>النوع</th><th class="n">السعر</th><th>الحالة</th><th>اتبعتت</th></tr></thead><tbody>${ls.map(l => `<tr><td>#${l.id} ${esc(l.name)}</td><td>${TY()[l.type]}</td><td class="n">${money(l.price)}</td><td>${pill(...LS[l.state])}</td><td>${fmt(l.sent_at)}</td></tr>`).join('')}</tbody></table>`;
  });
}

/* ----- universities / batches ----- */
function batchTable(bs, compact) {
  if (!bs.length) return empty('مفيش دفعات');
  const canExam = ['admin', 'coordinator'].includes(ME.role);
  return `<table class="stack"><thead><tr><th>الدفعة</th>${compact ? '' : '<th>المسؤول</th><th>المشرف</th>'}<th class="n">الاشتراكات</th><th class="n">متأخر</th><th class="n">مشاكل</th><th>أقرب امتحان</th><th class="n">محاضرات</th><th class="n">مراجعات</th><th class="n">ملفات أسئلة</th>${canExam ? '<th></th>' : ''}</tr></thead><tbody>${bs.map(b => {
    const trend = b.subs != null && b.subs_prev != null ? (b.subs > b.subs_prev ? ' <span class="ok">▲</span>' : b.subs < b.subs_prev ? ' <span class="red">▼</span>' : '') : '';
    return `<tr><td><b dir="ltr">${esc(b.code)}</b><div class="mut">${esc(b.uni)} · ${esc(b.year)}</div></td>${compact ? '' : `<td>${esc(b.coordinator || '—')}</td><td>${esc(b.supervisor || '—')}</td>`}<td class="n">${b.subs ?? '—'}${b.expected_subs ? ` / ${b.expected_subs}` : ''}${trend}</td><td class="n${b.lateNow ? ' red' : ''}">${b.lateNow}</td><td class="n${b.problems ? ' red' : ''}">${b.problems}</td><td>${b.exam_date ? `${esc(b.exam_date)}<div class="mut${b.exam_alert ? ' red' : ''}">${b.exam_days >= 0 ? `بعد ${b.exam_days} يوم` : 'عدّى'}${b.exam_alert ? ' · مفيش مراجعات' : ''}</div>` : '—'}</td><td class="n">${b.lectures}</td><td class="n">${b.revisions}</td><td class="n">${b.qfiles}</td>${canExam ? `<td><button class="btn g sm" data-exam="${b.id}">الامتحان</button></td>` : ''}</tr>`;
  }).join('')}</tbody></table>`;
}
V.unis = async () => {
  const bs = await api('GET', '/api/batches'); cache.batches = bs;
  const unis = {}; for (const b of bs) (unis[b.ucode] ||= { code: b.ucode, name: b.uni, list: [] }).list.push(b);
  const sel = cache.uni && unis[cache.uni] ? cache.uni : null;
  if (sel) {
    const u = unis[sel];
    $('#main').innerHTML = `<div class="row"><button class="btn g sm" id="back">← كل الجامعات</button></div><h2 style="margin-top:12px">${esc(u.name)} <span class="mut" dir="ltr">(${esc(u.code)})</span></h2><p class="note">${u.list.length} دفعة</p><div class="panel">${batchTable(u.list)}</div>`;
    $('#back').onclick = () => { cache.uni = null; V.unis(); };
  } else {
    $('#main').innerHTML = `<h2>${ME.role === 'admin' ? 'الجامعات' : 'دفعاتي'}</h2><p class="note">اضغط على أي جامعة تشوف دفعاتها بالتفصيل.</p><div class="cards">${Object.values(unis).map(u => {
      const subs = u.list.reduce((s, b) => s + (b.subs || 0), 0), exp = u.list.reduce((s, b) => s + (b.expected_subs || 0), 0), pr = u.list.reduce((s, b) => s + b.problems, 0), lt = u.list.reduce((s, b) => s + b.lateNow, 0);
      const sup = [...new Set(u.list.map(b => b.supervisor).filter(Boolean))].join('، ');
      return `<button class="card" data-uni="${esc(u.code)}"><span class="sc" dir="ltr">${esc(u.code)}</span><b>${esc(u.name)}</b><div class="mut">${esc(sup || '—')}</div><div class="st"><span>${u.list.length} دفعة</span><span>اشتراكات ${subs}${exp ? '/' + exp : ''}</span><span${pr ? ' class="red"' : ''}>مشاكل ${pr}</span><span${lt ? ' class="red"' : ''}>متأخر ${lt}</span></div></button>`;
    }).join('')}</div>`;
    document.querySelectorAll('[data-uni]').forEach(c => (c.onclick = () => { cache.uni = c.dataset.uni; V.unis(); }));
  }
  bindExam();
};
function bindExam() {
  document.querySelectorAll('[data-exam]').forEach(b => (b.onclick = () => {
    const bt = cache.batches.find(x => x.id === Number(b.dataset.exam));
    modal(`<b>امتحان ${esc(bt.code)}</b>`, `<form id="ef"><label>تاريخ أقرب امتحان<input type="date" name="exam_date" value="${esc(bt.exam_date || '')}"></label><label>ملاحظة<input name="exam_note" value="${esc(bt.exam_note || '')}"></label><button class="btn">حفظ</button></form>`);
    $('#ef').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target); await api('PATCH', '/api/batches/' + bt.id, { exam_date: f.get('exam_date'), exam_note: f.get('exam_note') }); dlg.close(); toast('اتحفظ'); render(); };
  }));
}

/* ----- lectures ----- */
const LF = { state: '', batch: '', doctor: '', type: '', q: '' };
V.lectures = async () => {
  const [bs, ds] = await Promise.all([api('GET', '/api/batches'), api('GET', '/api/doctors')]); cache.batches = bs; cache.doctors = ds;
  const canSend = ['admin', 'coordinator'].includes(ME.role);
  $('#main').innerHTML = `<div class="row sp"><h2>المحاضرات</h2>${canSend ? '<button class="btn a" id="newlec">+ إرسال محاضرة</button>' : ''}</div>
  <p class="note">كل محاضرة ليها تايمر ${esc(ME.settings.deadline_hours)} ساعة للفيديو وتايمر منفصل لملف الأسئلة، والرفع خلال ${esc(ME.settings.upload_minutes)} دقيقة من الاعتماد.</p>
  <div class="filters"><input id="fq" placeholder="بحث بالاسم أو الرقم" value="${esc(LF.q)}"><select id="fs">${opts(Object.entries(LS).map(([k, v]) => [k, v[0]]), LF.state, 'كل الحالات')}</select><select id="fb">${opts(bs.map(b => [b.id, b.code + ' · ' + b.uni]), LF.batch, 'كل الدفعات')}</select><select id="fd">${opts(ds.map(d => [d.id, d.name]), LF.doctor, 'كل الدكاترة')}</select><select id="ft">${opts(Object.entries(TY()), LF.type, 'كل الأنواع')}</select></div><div id="lt"></div>`;
  const load = async () => { const q = new URLSearchParams(Object.entries(LF).filter(([, v]) => v)); const ls = await api('GET', '/api/lectures?' + q); $('#lt').innerHTML = `<p class="mut">${ls.length} محاضرة</p><div class="panel" style="padding:6px 10px">${lecTable(ls)}</div>`; };
  const bind = (id, k, ev = 'change') => ($(id)['on' + ev] = () => { LF[k] = $(id).value; load(); });
  bind('#fs', 'state'); bind('#fb', 'batch'); bind('#fd', 'doctor'); bind('#ft', 'type');
  let tm; $('#fq').oninput = () => { clearTimeout(tm); tm = setTimeout(() => { LF.q = $('#fq').value; load(); }, 300); };
  if (canSend) $('#newlec').onclick = () => sendLectureForm();
  load();
};
function lecTable(ls) {
  if (!ls.length) return empty('مفيش محاضرات');
  return `<table class="stack"><thead><tr><th>#</th><th>المحاضرة</th><th>الدكتور</th><th>النوع</th><th>الفيديو</th><th>الأسئلة</th><th>الحالة</th><th></th></tr></thead><tbody>${ls.map(l => `<tr><td><b>${l.id}</b><div class="mut">${fmt(l.sent_at)}</div></td><td>${esc(l.name)}<div class="mut"><span dir="ltr">${esc(l.batch_code || '')}</span> · ${esc(l.coordinator || '')}</div></td><td>${esc(l.doctor)}</td><td>${TY()[l.type]}<div class="mut">${money(l.price)}</div></td><td>${fcell(l, 'v')}</td><td>${fcell(l, 'q')}</td><td>${pill(...LS[l.state])}${l.upload_late ? '<div class="mut red">الرفع اتأخر</div>' : ''}</td><td><button class="btn g sm" data-lec="${l.id}">فتح</button></td></tr>`).join('')}</tbody></table>`;
}
function sendLectureForm() {
  const bs = cache.batches, ds = cache.doctors;
  modal('<b>إرسال محاضرة جديدة</b>', `<form id="sf"><div class="two"><label>الدفعة<select name="batch_id" required>${opts(bs.map(b => [b.id, b.code + ' · ' + b.uni + ' ' + b.year]), '', 'اختار الدفعة')}</select></label><label>الدكتور<select name="doctor_id" id="sd" required>${opts(ds.map(d => [d.id, d.name + (d.linked ? '' : ' (مش مربوط بالبوت)')]), '', 'اختار الدكتور')}</select></label></div>
  <p class="mut" id="cap"></p><div class="two"><label>النوع<select name="type" id="st">${opts(Object.entries(TY()), 'theory')}</select></label><label>السعر<input name="price" id="sp" type="number" step="0.01" min="0" required></label></div>
  <label>اسم المحاضرة<input name="name" required dir="auto" placeholder="Anatomy – Lec 12: Thorax"></label>
  <div class="two"><label>ملف المحاضرة PDF<input type="file" name="lec" accept="application/pdf,.pdf"></label><label>مرجع الأسئلة (اختياري)<input type="file" name="qsrc"></label></div>
  <p class="mut">الدكتور هيشوف اسم المحاضرة ونوعها وسعرها والملفات بس، من غير اسم الجامعة أو الكود.</p><button class="btn a wide">إرسال للدكتور عبر البوت</button></form>`);
  const upd = () => {
    const d = ds.find(x => x.id === Number($('#sd').value)), t = $('#st').value;
    if (!d) { $('#cap').textContent = ''; return; }
    const base = t === 'repeat' ? d.price_theory * Number(ME.settings.repeat_ratio) : d['price_' + t];
    $('#sp').value = base ?? 0;
    const s = d.stats; $('#cap').innerHTML = `اتبعتله النهارده ${s.sentToday} من طاقته ${s.capacity}${s.sentToday >= s.capacity ? ' · <span class="red">وصل لطاقته</span>' : ''} · متأخر الآن ${s.lateNow}`;
  };
  $('#sd').onchange = upd; $('#st').onchange = upd;
  $('#sf').onsubmit = async e => {
    e.preventDefault(); const btn = e.target.querySelector('button'); btn.disabled = true;
    try { const r = await api('POST', '/api/lectures', new FormData(e.target)); dlg.close(); toast(`اتبعتت · #${r.id}${r.delivered_to_bot ? '' : ' (الدكتور مش مربوط بالبوت، الملفات مااتبعتتش)'}${r.over_capacity ? ' · فوق طاقته' : ''}`); render(); } catch { btn.disabled = false; }
  };
}
async function openLecture(id) {
  const l = await api('GET', '/api/lectures/' + id), staff = ['admin', 'coordinator'].includes(ME.role);
  const both = l.video_at && l.q_at, approved = l.video_ok_at && l.q_ok_at;
  const log = [[l.sent_at, 'اتبعتت للدكتور عبر البوت'], l.video_at && [l.video_at, 'الفيديو اتسلم' + (l.v_late ? ' (متأخر)' : '')], l.video_ok_at && [l.video_ok_at, 'الفيديو اتعتمد'], l.q_at && [l.q_at, 'ملف الأسئلة اتسلم' + (l.q_late ? ' (متأخر)' : '')], l.q_ok_at && [l.q_ok_at, 'ملف الأسئلة اتعتمد'], l.uploaded_at && [l.uploaded_at, 'اترفعت على Nerdio والقناة' + (l.upload_late ? ' (متأخر)' : '')], ...(l.price_log || []).map(p => [p.at, `السعر اتغير من ${money(p.old)} لـ ${money(p.new)} (${p.by_name})`])].filter(Boolean).sort((a, b) => a[0] - b[0]);
  const ni = (n, lab, m) => `<label>${lab} (من ${m})<input type="number" name="${n}" min="0" max="${m}" value="${l[n] ?? ''}" ${approved ? '' : 'disabled'}></label>`;
  modal(`<b>#${l.id}</b> ${pill(...LS[l.state])}<div>${esc(l.name)}</div>`, `<p class="mut">${l.batch_code ? `<span dir="ltr">${esc(l.batch_code)}</span> · ${esc(l.university)} ${esc(l.batch_year)} · ` : ''}${esc(l.doctor)} · ${TY()[l.type]} · السعر ${money(l.price)}${l.coordinator ? ' · ' + esc(l.coordinator) : ''}</p>
  <div class="two"><div class="panel"><h3>الفيديو</h3>${fcell(l, 'v')}</div><div class="panel"><h3>ملف الأسئلة</h3>${fcell(l, 'q')}</div></div>
  <h3>سجل العمليات</h3><ul class="log">${log.map(([t, x]) => `<li><span class="mut">${fmt(t)}</span><br>${esc(x)}</li>`).join('')}</ul>
  ${staff ? `<div class="row" style="margin:14px 0">${(l.video_at || l.q_at) ? '<button class="btn g sm" id="fw">ابعتلي الملفات على تليجرام</button>' : ''}${!l.settlement_id ? '<button class="btn g sm" id="pr">تعديل السعر</button>' : ''}${ME.role === 'admin' && !l.settlement_id ? '<button class="btn sm r" id="cx">مسح المحاضرة</button>' : ''}</div>
  <form id="af" class="panel"><h3>الاعتماد</h3>${l.video_at && !l.video_ok_at ? '<label class="chk"><input type="checkbox" name="video"> اعتماد الفيديو</label>' : ''}${l.q_at && !l.q_ok_at ? '<label class="chk"><input type="checkbox" name="q"> اعتماد ملف الأسئلة</label>' : ''}${!both ? '<p class="mut">المحاضرة مش هتتقفل غير لما الفيديو والأسئلة يوصلوا ويتعتمدوا.</p>' : ''}${(l.video_at && !l.video_ok_at) || (l.q_at && !l.q_ok_at) ? '<button class="btn sm">اعتماد</button>' : approved ? '<p class="ok">الاتنين معتمدين ✓</p>' : ''}</form>
  <form id="rf" class="panel"><h3>التقييم</h3><p class="mut">الالتزام بالموعد (35) بيتحسب لوحده.${approved ? '' : ' التقييم بيتفتح بعد الاعتماد.'}</p><div class="four">${ni('r_video', 'جودة الفيديو', 40)}${ni('r_q', 'جودة الأسئلة', 10)}${ni('r_instr', 'التعليمات', 10)}${ni('r_comm', 'التواصل', 5)}</div>${approved ? '<button class="btn sm">حفظ التقييم</button>' : ''}</form>
  ${approved ? `<div class="panel"><h3>الرفع</h3>${l.uploaded_at ? `<p class="ok">اترفعت ${fmt(l.uploaded_at)} ✓</p>` : `<p class="mut">ارفعها على Nerdio وقناة الدفعة وبعدين دوس هنا.</p><button class="btn a" id="up">تم الرفع</button>`}</div>` : ''}` : ''}`);
  if (!staff) return;
  const act = async (b, msg) => { await api('PATCH', '/api/lectures/' + id, b); toast(msg); openLecture(id); render(); };
  $('#af').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); act({ action: 'approve', video: !!f.get('video'), q: !!f.get('q') }, 'اتعتمد'); };
  $('#rf').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); act({ action: 'rate', r_video: f.get('r_video'), r_q: f.get('r_q'), r_instr: f.get('r_instr'), r_comm: f.get('r_comm') }, 'التقييم اتحفظ'); };
  if ($('#up')) $('#up').onclick = () => act({ action: 'uploaded' }, 'اتسجل الرفع');
  if ($('#fw')) $('#fw').onclick = () => act({ action: 'forward' }, 'الملفات اتبعتتلك على تليجرام');
  if ($('#cx')) $('#cx').onclick = () => { modal(`<b>مسح المحاضرة #${l.id}</b>`, `<p>${esc(l.name)}</p><p class="red">المحاضرة هتتمسح نهائي بكل بياناتها وتقييمها، ومش هتتحسب في أي حساب. متأكد؟</p><div class="row"><button class="btn r" id="cxy">أيوه، امسحها</button><button class="btn g" data-close>لا</button></div>`); $('#cxy').onclick = async () => { await api('PATCH', '/api/lectures/' + id, { action: 'cancel' }); dlg.close(); toast('اتمسحت'); render(); }; };
  if ($('#pr')) $('#pr').onclick = () => modal(`<b>تعديل سعر #${l.id}</b>`, `<form id="pf"><label>السعر الجديد<input type="number" step="0.01" min="0" name="price" value="${l.price}" required></label><p class="mut">التعديل بيتسجل باسمك والدكتور بيتبلّغ على البوت.</p><button class="btn">حفظ</button></form>`) || ($('#pf').onsubmit = async e => { e.preventDefault(); await api('PATCH', '/api/lectures/' + id, { action: 'price', price: new FormData(e.target).get('price') }); toast('السعر اتعدّل'); openLecture(id); render(); });
}

/* ----- tickets ----- */
let TF = 'open';
const STG = { new: ['جديد · مستني يتبعت للدكتور', 'pd'], doctor: ['عند الدكتور', 'rv'], return: ['مستني يرجع لخدمة العملاء', 'warn'], deliver: ['مستني يتبعت للطالب', 'warn'], problem: ['مشكلة مفتوحة', 'bad'], closed: ['مقفولة', 'ok'] };
V.tickets = async () => {
  const [ts, bs] = await Promise.all([api('GET', '/api/tickets' + (TF === 'open' ? '?open=1' : '')), api('GET', '/api/batches')]); cache.batches = bs; cache.tickets = ts;
  const mineFirst = ME.role === 'cs' ? ['deliver'] : ME.role === 'coordinator' ? ['new', 'return', 'problem'] : [];
  ts.sort((a, b) => (mineFirst.includes(b.stage) - mineFirst.includes(a.stage)));
  $('#main').innerHTML = `<div class="row sp"><h2>الأسئلة والمشاكل</h2>${['admin', 'cs', 'coordinator'].includes(ME.role) ? '<button class="btn a" id="nt">+ تذكرة جديدة</button>' : ''}</div>
  <p class="note">مسؤول الدفعة معاه ${esc(ME.settings.coord_reply_minutes)} دقيقة يرجّع رد الدكتور، وخدمة العملاء معاها ${esc(ME.settings.cs_reply_minutes)} دقيقة توصّله للطالب.</p>
  <div class="tabs"><button data-tf="open" class="${TF === 'open' ? 'on' : ''}">المفتوحة</button><button data-tf="all" class="${TF === 'all' ? 'on' : ''}">الكل</button></div>
  <div class="panel" style="padding:6px 10px">${ts.length ? `<table class="stack"><thead><tr><th>#</th><th>النوع</th><th>الدفعة</th><th>النص</th><th>المرحلة</th><th>الوقت</th><th></th></tr></thead><tbody>${ts.map(t => `<tr><td><b>${t.id}</b></td><td>${t.kind === 'question' ? 'سؤال' : 'مشكلة'}</td><td dir="ltr">${esc(t.batch_code)}</td><td>${esc(t.body.slice(0, 90))}${t.student ? `<div class="mut">${esc(t.student)}</div>` : ''}</td><td>${pill(...STG[t.stage])}${t.coord_late ? '<div class="mut red">المسؤول اتأخر</div>' : ''}${t.cs_late ? '<div class="mut red">خدمة العملاء اتأخرت</div>' : ''}</td><td>${fmt(t.created_at)}</td><td><button class="btn g sm" data-tk="${t.id}">فتح</button></td></tr>`).join('')}</tbody></table>` : empty('مفيش تذاكر')}</div>`;
  document.querySelectorAll('[data-tf]').forEach(b => (b.onclick = () => { TF = b.dataset.tf; V.tickets(); }));
  if ($('#nt')) $('#nt').onclick = newTicket;
};
function newTicket() {
  modal('<b>تذكرة جديدة</b>', `<form id="tf"><div class="two"><label>النوع<select name="kind">${opts([['question', 'سؤال طالب'], ['problem', 'مشكلة']], 'question')}</select></label><label>الدفعة<select name="batch_id" id="tb" required>${opts(cache.batches.map(b => [b.id, b.code + ' · ' + b.uni]), '', 'اختار الدفعة')}</select></label></div>
  <label>المحاضرة (للأسئلة)<select name="lecture_id" id="tl"><option value="">—</option></select></label><label>الطالب (اسم أو رقم)<input name="student"></label><label>النص<textarea name="body" required></textarea></label><button class="btn a">فتح التذكرة</button></form>`);
  $('#tb').onchange = async () => { const ls = await api('GET', '/api/lectures?limit=200&batch=' + $('#tb').value); $('#tl').innerHTML = '<option value="">—</option>' + ls.map(l => `<option value="${l.id}">#${l.id} ${esc(l.name)} · ${esc(l.doctor)}</option>`).join(''); };
  $('#tf').onsubmit = async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); const r = await api('POST', '/api/tickets', f); dlg.close(); toast('التذكرة اتفتحت #' + r.id); render(); };
}
async function openTicket(id) {
  let t = (cache.tickets || []).find(x => x.id === id);
  if (!t) { const ts = await api('GET', '/api/tickets'); t = ts.find(x => x.id === id); if (!t) return toast('مش موجودة'); }
  const coord = ['admin', 'coordinator'].includes(ME.role), cs = ['admin', 'cs'].includes(ME.role);
  const log = [[t.created_at, `اتفتحت بواسطة ${t.created_by_name}`], t.sent_doctor_at && [t.sent_doctor_at, `اتبعتت لـ ${t.doctor}`], t.reply_at && [t.reply_at, `الدكتور رد (بعد ${dur(t.reply_at - t.sent_doctor_at)})`], t.returned_at && [t.returned_at, `رجعت لخدمة العملاء (بعد ${dur(t.returned_at - t.reply_at)})${t.coord_late ? ' · متأخر' : ''}`], t.delivered_at && [t.delivered_at, `اتبعتت للطالب (بعد ${dur(t.delivered_at - t.returned_at)})${t.cs_late ? ' · متأخر' : ''}`], t.kind === 'problem' && t.closed_at && [t.closed_at, 'اتحلت واتقفلت']].filter(Boolean);
  let act = '';
  if (t.stage === 'new' && coord) { const ds = cache.doctors || (cache.doctors = await api('GET', '/api/doctors')); act = `<form id="ta" class="panel"><h3>ابعت السؤال للدكتور</h3><label>الدكتور<select name="doctor_id" required>${opts(ds.map(d => [d.id, d.name]), t.doctor_id, 'اختار')}</select></label><button class="btn a">إرسال عبر البوت</button></form>`; }
  if (t.stage === 'doctor' && coord) act = `<form id="tr" class="panel"><h3>الدكتور لسه مارد</h3><p class="mut">لو رد عليك برة البوت اكتب الرد هنا.</p><textarea name="reply" required></textarea><button class="btn sm">تسجيل الرد</button></form>`;
  if (t.stage === 'return' && coord) act = `<div class="panel"><h3>رجّع الرد لخدمة العملاء</h3><button class="btn a" id="tret">تم، الرد رجع لخدمة العملاء</button></div>`;
  if (t.stage === 'deliver' && cs) act = `<div class="panel"><h3>ابعت الرد للطالب</h3><button class="btn a" id="tdel">تم، الرد اتبعت للطالب</button></div>`;
  if (t.stage === 'problem' && (coord || cs)) act = `<form id="tc" class="panel"><h3>قفل المشكلة</h3><label>اتحلت إزاي<textarea name="resolution" required></textarea></label><button class="btn a">قفل</button></form>`;
  if (ME.role === 'admin') act += `<div class="row" style="margin-top:12px"><button class="btn sm r" id="tdx">مسح التذكرة</button></div>`;
  modal(`<b>${t.kind === 'question' ? 'سؤال' : 'مشكلة'} #${t.id}</b> ${pill(...STG[t.stage])}`, `<p class="mut"><span dir="ltr">${esc(t.batch_code)}</span>${t.lecture ? ' · ' + esc(t.lecture) : ''}${t.student ? ' · الطالب: ' + esc(t.student) : ''}</p><div class="panel">${esc(t.body)}</div>${t.reply ? `<div class="panel"><h3>رد الدكتور</h3>${esc(t.reply)}</div>` : ''}${t.resolution ? `<div class="panel"><h3>الحل</h3>${esc(t.resolution)}</div>` : ''}<h3>المراحل</h3><ul class="log">${log.map(([a, x]) => `<li><span class="mut">${fmt(a)}</span><br>${esc(x)}</li>`).join('')}</ul>${act}`);
  const go = async (b, m) => { await api('PATCH', '/api/tickets/' + id, b); dlg.close(); toast(m); render(); };
  if ($('#ta')) $('#ta').onsubmit = e => { e.preventDefault(); go({ action: 'send_doctor', doctor_id: new FormData(e.target).get('doctor_id') }, 'اتبعت للدكتور'); };
  if ($('#tr')) $('#tr').onsubmit = e => { e.preventDefault(); go({ action: 'set_reply', reply: new FormData(e.target).get('reply') }, 'الرد اتسجل'); };
  if ($('#tret')) $('#tret').onclick = () => go({ action: 'return' }, 'رجع لخدمة العملاء');
  if ($('#tdel')) $('#tdel').onclick = () => go({ action: 'deliver' }, 'التذكرة اتقفلت');
  if ($('#tdx')) $('#tdx').onclick = () => { if ($('#tdx').dataset.sure) return go({ action: 'delete' }, 'اتمسحت'); $('#tdx').dataset.sure = 1; $('#tdx').textContent = 'متأكد؟ دوس تاني للمسح'; };
  if ($('#tc')) $('#tc').onsubmit = e => { e.preventDefault(); go({ action: 'close', resolution: new FormData(e.target).get('resolution') }, 'المشكلة اتقفلت'); };
}

/* ----- checklist ----- */
V.checklist = async () => {
  const r = await api('GET', '/api/checklist'); const s = r.summary;
  const hints = { uploaded: s.toUpload ? `<span class="red">فيه ${s.toUpload} محاضرة مستنية رفع</span>` : 'مفيش محاضرات مستنية رفع ✓', remind: s.lateNow ? `<span class="red">${s.lateNow} محاضرة متأخرة</span> · البوت بيفكّر الدكاترة لوحده` : 'مفيش متأخر ✓', questions: s.ticketsLate ? `<span class="red">${s.ticketsLate} تذكرة عدّت المهلة</span>` : '' };
  const row = it => `<div class="panel" style="margin-bottom:10px"><label class="chk" style="margin:0"><input type="checkbox" data-item="${it.key}" ${it.done ? 'checked' : ''}> <span>${esc(it.label)}</span></label>${hints[it.key] ? `<div class="mut" style="margin:4px 30px 0 0">${hints[it.key]}</div>` : ''}<textarea data-note="${it.key}" placeholder="اكتب عملت إيه" style="margin-top:8px;min-height:56px">${esc(it.note)}</textarea></div>`;
  const done = r.items.filter(i => !i.weekly && i.done).length, tot = r.items.filter(i => !i.weekly).length;
  $('#main').innerHTML = `<h2>مهام النهارده · ${done}/${tot}</h2><p class="note">علّم على كل مهمة لما تخلصها واكتب تحتها عملت إيه. الليستة دي بتتجمع في تقرير يوصل لمشرفك آخر اليوم.</p>
  <h3>اليومية</h3>${r.items.filter(i => !i.weekly).map(row).join('')}<h3 style="margin-top:18px">الأسبوعية</h3>${r.items.filter(i => i.weekly).map(row).join('')}`;
  const save = async key => { await api('PUT', '/api/checklist', { item: key, done: document.querySelector(`[data-item="${key}"]`).checked, note: document.querySelector(`[data-note="${key}"]`).value }); toast('اتحفظ'); };
  document.querySelectorAll('[data-item]').forEach(c => (c.onchange = () => save(c.dataset.item)));
  document.querySelectorAll('[data-note]').forEach(t => (t.onchange = () => save(t.dataset.note)));
};

/* ----- reports ----- */
const sumLines = s => `<div class="kpis">${kpi(s.sent, 'اتبعتت')}${kpi(s.videos, 'فيديوهات')}${kpi(s.qfiles, 'ملفات أسئلة')}${kpi(s.uploaded, 'اترفعت')}${kpi(s.lateNow, 'متأخرة الآن', s.lateNow)}${kpi(s.questions, 'أسئلة')}${kpi(s.ticketsLate, 'تذاكر متأخرة', s.ticketsLate)}${kpi(s.problemsOpen, 'مشاكل مفتوحة', s.problemsOpen)}</div>`;
V.reports = async () => {
  const day = cache.rday || ME.today; const r = await api('GET', '/api/reports?day=' + day);
  const dayPick = `<input type="date" id="rday" value="${esc(day)}" style="width:auto">`;
  if (ME.role === 'supervisor') {
    const s = r.draft, draft = r.mine?.body || `ملخص ${day}:\n- اتبعتت ${s.sent} محاضرة، واتسلم ${s.videos} فيديو و${s.qfiles} ملف أسئلة، واترفعت ${s.uploaded}.\n- متأخر دلوقتي ${s.lateNow}، ومشاكل مفتوحة ${s.problemsOpen}.\n- `;
    $('#main').innerHTML = `<div class="row sp"><h2>التقرير اليومي</h2>${dayPick}</div>${sumLines(s)}
    <section class="panel"><h3>تقارير التيم</h3>${r.team.map(c => `<details class="panel" style="margin-bottom:8px"><summary><b>${esc(c.name)}</b> · ${c.report.items.filter(i => i.done && !i.weekly).length}/${c.report.items.filter(i => !i.weekly).length} مهام</summary>${c.report.items.map(i => `<p>${i.done ? '✓' : '✗'} ${esc(i.label)}${i.note ? `<br><span class="mut">${esc(i.note)}</span>` : ''}</p>`).join('')}</details>`).join('') || empty('مفيش مسؤولين')}</section>
    <form id="rf" class="panel"><h3>ملخص يومك ${r.mine ? '<span class="ok">(اترفع ✓)</span>' : ''}</h3><textarea name="body" rows="8" required>${esc(draft)}</textarea><button class="btn a">رفع التقرير للأدمن</button></form>`;
    $('#rf').onsubmit = async e => { e.preventDefault(); await api('PUT', '/api/reports', { body: new FormData(e.target).get('body') }); toast('التقرير اترفع'); V.reports(); };
  } else {
    $('#main').innerHTML = `<div class="row sp"><h2>تقارير ${esc(day)}</h2>${dayPick}</div>${sumLines(r.summary)}
    <section class="panel"><h3>تقارير المشرفين</h3>${r.supervisors.map(s => `<div class="panel"><b>${esc(s.name)}</b> ${s.body ? `<span class="mut">${fmt(s.created_at)}</span><p style="white-space:pre-wrap">${esc(s.body)}</p>` : '<p class="red">لسه مارفعش تقريره</p>'}</div>`).join('')}</section>
    <section class="panel"><div class="row sp"><h3>برومبت التحليل اليومي</h3><button class="btn a sm" id="cp">نسخ البرومبت</button></div><p class="mut">انسخه وحطه في أي ذكاء اصطناعي يحللك اليوم ويقولك تعمل إيه بكرة.</p><pre class="prompt" id="pt">بيحمّل…</pre></section>`;
    api('GET', '/api/prompt?day=' + day).then(p => { $('#pt').textContent = p.text; });
    $('#cp').onclick = async () => { try { await navigator.clipboard.writeText($('#pt').textContent); toast('اتنسخ'); } catch { toast('حدد النص وانسخه بإيدك'); } };
  }
  $('#rday').onchange = () => { cache.rday = $('#rday').value; V.reports(); };
};

/* ----- doctors ----- */
V.doctors = async () => {
  const ds = await api('GET', '/api/doctors'); cache.doctors = ds;
  ds.sort((a, b) => a.stats.score.total - b.stats.score.total);
  $('#main').innerHTML = `<h2>الدكاترة</h2><p class="note">مرتبين من الأقل تقييمًا. التقييم من 100: الموعد 35، جودة الفيديو 40، جودة الأسئلة 10، التعليمات 10، التواصل 5.</p><div class="cards">${ds.map(d => { const s = d.stats; return `<button class="card" data-doc="${d.id}"><span class="sc${s.score.total < 70 ? ' red' : ''}">${s.score.total}</span><b>${esc(d.name)}</b><div class="mut">${d.linked ? 'مربوط بالبوت ✓' : '<span class="red">مش مربوط بالبوت</span>'}</div><div class="st"><span>سلّم ${s.delivered}/${s.assigned}</span><span${s.lateNow ? ' class="red"' : ''}>متأخر ${s.lateNow}</span><span>الالتزام ${pct(s.compliance)}</span><span>النهارده ${s.sentToday}/${s.capacity}</span><span${s.shortDays ? ' class="red"' : ''}>أيام تقصير ${s.shortDays}</span></div></button>`; }).join('') || empty('مفيش دكاترة لسه. ضيفهم من الإعدادات.')}</div>`;
};
async function openDoctor(id) {
  const d = await api('GET', '/api/doctors/' + id), s = d.stats, sc = s.score, admin = ME.role === 'admin';
  modal(`<b>${esc(d.name)}</b><div class="mut">${esc(d.phone || '')} ${d.linked ? '· مربوط بالبوت ✓' : '· <span class="red">مش مربوط</span>'}</div>`, `<div class="kpis" style="margin-top:0">${kpi(sc.total, 'التقييم', sc.total < 70)}${kpi(s.assigned, 'مسندة')}${kpi(s.delivered, 'سلّمها')}${kpi(s.open, 'مفتوحة')}${kpi(s.lateNow, 'متأخرة الآن', s.lateNow)}${kpi(s.lateEver, 'اتأخر فيها قبل كده')}${kpi(`${s.today} / ${s.month}`, 'النهارده / آخر 30 يوم')}${kpi(s.shortDays, 'أيام تقصير في الطاقة', s.shortDays)}</div>
  <p class="mut">متوسط تسليم الفيديو ${dur(s.avgVideo)} · الأسئلة ${dur(s.avgQ)} · الطاقة ${s.capacity} في اليوم</p>
  ${meter('الالتزام بالموعد', sc.dl, 35, `${Math.round(sc.dl)}/35`)}${meter('جودة الفيديو', sc.video ?? 0, 40, sc.video == null ? '—' : `${Math.round(sc.video)}/40`)}${meter('جودة الأسئلة', sc.q ?? 0, 10, sc.q == null ? '—' : `${Math.round(sc.q)}/10`)}${meter('التعليمات', sc.instr ?? 0, 10, sc.instr == null ? '—' : `${Math.round(sc.instr)}/10`)}${meter('التواصل', sc.comm ?? 0, 5, sc.comm == null ? '—' : `${Math.round(sc.comm)}/5`)}
  ${d.price_theory != null ? `<p>الأسعار: نظري ${money(d.price_theory)} · عملي ${money(d.price_practical)} · مراجعة ${money(d.price_revision)}</p>` : ''}
  ${admin ? `<form id="cf" class="panel"><h3>التعاقد</h3><div class="four"><label>نظري<input type="number" step="0.01" name="price_theory" value="${d.price_theory}"></label><label>عملي<input type="number" step="0.01" name="price_practical" value="${d.price_practical}"></label><label>مراجعة<input type="number" step="0.01" name="price_revision" value="${d.price_revision}"></label><label>الطاقة اليومية<input type="number" name="capacity" value="${d.capacity}"></label></div><label>تعديل التقييم من الإدارة (+/−)<input type="number" name="adj" value="${d.adj || 0}" min="-30" max="30"></label>${!d.linked ? `<p>كود الربط: <code>${esc(d.link_code)}</code></p>` : ''}<button class="btn sm">حفظ</button></form>` : ''}
  <h3>آخر المحاضرات</h3>${lecTable(d.lectures)}
  <h3>العقوبات</h3>${d.penalties.length ? d.penalties.map(p => `<p>${pill(PST[p.status][0], PST[p.status][1])} ${esc(p.kind)}${p.amount ? ' · ' + money(p.amount) : ''} · ${esc(p.reason)} <span class="mut">${fmt(p.created_at)}</span></p>`).join('') : '<p class="mut">مفيش</p>'}`);
  if ($('#cf')) $('#cf').onsubmit = async e => { e.preventDefault(); await api('PATCH', '/api/doctors/' + id, Object.fromEntries(new FormData(e.target))); toast('اتحفظ'); openDoctor(id); };
}

/* ----- team ----- */
V.team = async () => {
  const t = await api('GET', '/api/team');
  const cRows = (t.coordinators || []).map(c => `<tr><td><b>${esc(c.name)}</b><div class="mut" dir="ltr">${esc(c.batches.join(' · '))}</div></td><td class="n"><b>${c.stats.score.total}</b></td><td class="n">${Math.round(c.stats.score.subs)}/30</td><td class="n">${Math.round(c.stats.score.deadlines)}/30</td><td class="n">${Math.round(c.stats.score.problems)}/20</td><td class="n">${Math.round(c.stats.score.checklist)}/20</td><td class="n${c.stats.replyLate ? ' red' : ''}">${c.stats.replyLate}</td><td class="n${c.stats.uploadLate ? ' red' : ''}">${c.stats.uploadLate}</td><td class="n">${c.stats.openProblems}</td>${ME.role === 'supervisor' || ME.role === 'admin' ? `<td><button class="btn g sm" data-cl="${c.id}" data-n="${esc(c.name)}">مهام اليوم</button></td>` : ''}</tr>`).join('');
  let html = `<h2>${ME.role === 'admin' ? 'الفريق' : 'التيم'}</h2><p class="note">التقييمات محسوبة من آخر 30 يوم.</p><section class="panel"><h3>مسؤولين الدفعات</h3><table class="stack"><thead><tr><th>الاسم</th><th class="n">التقييم</th><th class="n">الاشتراكات</th><th class="n">المهل</th><th class="n">المشاكل</th><th class="n">الليستة</th><th class="n">ردود اتأخرت</th><th class="n">رفع اتأخر</th><th class="n">مشاكل مفتوحة</th><th></th></tr></thead><tbody>${cRows}</tbody></table></section>`;
  if (t.supervisors) html += `<section class="panel"><h3>المشرفين</h3><table class="stack"><thead><tr><th>الاسم</th><th class="n">التقييم</th><th class="n">الاشتراكات</th><th class="n">التقصير والتأخير</th><th class="n">المشاكل</th><th class="n">التقارير</th><th class="n">متأخر الآن</th></tr></thead><tbody>${t.supervisors.map(s => `<tr><td><b>${esc(s.name)}</b><div class="mut">${s.stats.batches} دفعة</div></td><td class="n"><b>${s.stats.score.total}</b></td><td class="n">${Math.round(s.stats.score.subs)}/40</td><td class="n">${Math.round(s.stats.score.delays)}/30</td><td class="n">${Math.round(s.stats.score.problems)}/20</td><td class="n">${Math.round(s.stats.score.reports)}/10</td><td class="n${s.stats.lateNow ? ' red' : ''}">${s.stats.lateNow}</td></tr>`).join('')}</tbody></table></section>
  <section class="panel"><h3>خدمة العملاء</h3><table class="stack"><thead><tr><th>الاسم</th><th class="n">الالتزام بالنص ساعة</th><th class="n">تذاكر</th><th class="n">اتأخرت</th><th class="n">فتحت</th></tr></thead><tbody>${t.cs.map(c => `<tr><td>${esc(c.name)}</td><td class="n"><b>${c.stats.score}%</b></td><td class="n">${c.stats.handled}</td><td class="n${c.stats.late ? ' red' : ''}">${c.stats.late}</td><td class="n">${c.stats.created}</td></tr>`).join('')}</tbody></table></section>`;
  $('#main').innerHTML = html;
  document.querySelectorAll('[data-cl]').forEach(b => (b.onclick = async () => { const r = await api('GET', '/api/checklist?user=' + b.dataset.cl); modal(`<b>${esc(b.dataset.n)} · ${esc(r.day)}</b>`, r.items.map(i => `<p>${i.done ? '✓' : '✗'} ${esc(i.label)}${i.note ? `<br><span class="mut">${esc(i.note)}</span>` : ''}</p>`).join('')); }));
};

/* ----- penalties ----- */
const PST = { proposed: ['مقترح', 'pd'], approved: ['معتمد', 'ok'], rejected: ['مرفوض', 'rv'] };
V.penalties = async () => {
  const ps = await api('GET', '/api/penalties'), admin = ME.role === 'admin', canAdd = ['admin', 'supervisor', 'coordinator'].includes(ME.role);
  let targets = [];
  if (canAdd) { const ds = await api('GET', '/api/doctors'); targets = ds.map(d => [d.id, d.name + ' · دكتور']); if (admin) { const us = await api('GET', '/api/users'); targets = us.filter(u => u.role !== 'admin' && u.active).map(u => [u.id, u.name + ' · ' + ROLE[u.role]]); } else if (ME.role === 'supervisor') { const t = await api('GET', '/api/team'); targets = targets.concat(t.coordinators.map(c => [c.id, c.name + ' · مسؤول دفعة'])); } }
  $('#main').innerHTML = `<h2>${ME.role === 'doctor' || ME.role === 'cs' ? 'القرارات' : 'العقوبات والجزاءات'}</h2><p class="note">${admin ? 'إنت بتقرر كل حالة بنفسك. أي خصم معتمد بيتطرح تلقائي من حساب الشهر، وصاحبه بيتبلّغ على البوت.' : canAdd ? 'تقدر تقترح قرار، والأدمن هو اللي بيعتمده.' : 'لو عندك اعتراض على قرار اكتبه هنا والإدارة هترد.'}</p>
  ${canAdd ? `<details class="panel"><summary><b>${admin ? 'قرار جديد' : 'اقتراح قرار'}</b></summary><form id="nf" style="margin-top:10px"><label>الشخص<select name="user_id" required>${opts(targets, '', 'اختار')}</select></label><label>السبب<input name="reason" required></label><div class="two"><label>النوع<select name="kind">${opts(['إنذار شفهي', 'إنذار كتابي', 'خصم', 'إيقاف مؤقت', 'أخرى'].map(x => [x, x]), 'خصم')}</select></label><label>قيمة الخصم<input type="number" step="0.01" min="0" name="amount" value="0"></label></div><button class="btn">${admin ? 'اعتماد وتبليغ' : 'إرسال للأدمن'}</button></form></details>` : ''}
  <div class="panel" style="padding:6px 10px">${ps.length ? `<table class="stack"><thead><tr><th>الشخص</th><th>السبب</th><th>القرار</th><th>الحالة</th><th>الاعتراض</th><th></th></tr></thead><tbody>${ps.map(p => `<tr><td><b>${esc(p.target)}</b><div class="mut">${ROLE[p.target_role] || ''}</div></td><td>${esc(p.reason)}<div class="mut">${fmt(p.created_at)}${p.proposer ? ' · ' + esc(p.proposer) : ''}</div></td><td>${esc(p.kind)}${p.amount ? `<div class="mut">${money(p.amount)}</div>` : ''}</td><td>${pill(...PST[p.status])}</td><td>${p.objection ? esc(p.objection) + (p.reply ? `<div class="mut">الرد: ${esc(p.reply)}</div>` : '') : '—'}</td><td>${admin && p.status === 'proposed' ? `<button class="btn sm a" data-pa="${p.id}">اعتماد</button> <button class="btn sm g" data-pr="${p.id}">رفض</button>` : ''}${admin && p.objection && !p.reply ? `<button class="btn sm g" data-prep="${p.id}">رد</button>` : ''}${p.user_id === ME.id && p.status === 'approved' && !p.objection ? `<button class="btn sm g" data-po="${p.id}">اعتراض</button>` : ''}</td></tr>`).join('')}</tbody></table>` : empty('مفيش قرارات')}</div>`;
  if ($('#nf')) $('#nf').onsubmit = async e => { e.preventDefault(); await api('POST', '/api/penalties', Object.fromEntries(new FormData(e.target))); toast('اتسجل'); V.penalties(); };
  const P = (id, b, m) => api('PATCH', '/api/penalties/' + id, b).then(() => { dlg.close(); toast(m); V.penalties(); });
  document.querySelectorAll('[data-pa]').forEach(b => (b.onclick = () => P(b.dataset.pa, { action: 'approve' }, 'اتعتمد واتبلّغ')));
  document.querySelectorAll('[data-pr]').forEach(b => (b.onclick = () => P(b.dataset.pr, { action: 'reject' }, 'اترفض')));
  document.querySelectorAll('[data-po]').forEach(b => (b.onclick = () => { modal('<b>اعتراض</b>', '<form id="of"><textarea name="t" required placeholder="اكتب سبب الاعتراض"></textarea><button class="btn">إرسال</button></form>'); $('#of').onsubmit = e => { e.preventDefault(); P(b.dataset.po, { action: 'object', text: new FormData(e.target).get('t') }, 'الاعتراض وصل'); }; }));
  document.querySelectorAll('[data-prep]').forEach(b => (b.onclick = () => { modal('<b>الرد على الاعتراض</b>', '<form id="of"><textarea name="t" required></textarea><label class="chk"><input type="checkbox" name="c"> إلغاء القرار</label><button class="btn">إرسال</button></form>'); $('#of').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); P(b.dataset.prep, { action: 'reply', text: f.get('t'), cancel: !!f.get('c') }, 'الرد اتبعت'); }; }));
};

/* ----- finance ----- */
V.finance = async () => {
  const rows = await api('GET', '/api/finance');
  const tot = rows.reduce((s, r) => s + r.net, 0);
  $('#main').innerHTML = `<h2>الحسابات · المستحق دلوقتي ${money(tot)}</h2><p class="note">الدكتور بيتحاسب على المحاضرات اللي سلّمها بس، واللي ماسلّمهاش بتترحّل للفترة اللي بعدها. التقفيل الشهري أو المعجّل بيقفل المبالغ دي.</p>
  <div class="panel" style="padding:6px 10px"><table class="stack"><thead><tr><th>الاسم</th><th>الدور</th><th class="n">الأساسي</th><th class="n">بونص</th><th class="n">خصومات</th><th class="n">الصافي</th><th class="n">محاضرات</th><th></th></tr></thead><tbody>${rows.map(r => `<tr class="click" data-fin="${r.id}"><td><b>${esc(r.name)}</b></td><td>${ROLE[r.role]}</td><td class="n">${money(r.gross)}</td><td class="n">${money(r.bonus)}</td><td class="n${r.deductions ? ' red' : ''}">${money(r.deductions)}</td><td class="n"><b>${money(r.net)}</b></td><td class="n">${r.role === 'doctor' ? `${r.lectures}${r.pending ? ` <span class="mut">(+${r.pending} مفتوحة)</span>` : ''}` : '—'}</td><td><button class="btn g sm">فتح</button></td></tr>`).join('')}</tbody></table></div>`;
  document.querySelectorAll('[data-fin]').forEach(r => (r.onclick = () => openFinance(Number(r.dataset.fin))));
};
function finBody(f, admin) {
  return `<div class="kpis" style="margin-top:0">${kpi(money(f.gross), f.user.role === 'doctor' ? 'المحاضرات' : 'الأساسي')}${kpi(money(f.bonus), 'بونص')}${kpi(money(f.deductions), 'خصومات', f.deductions)}${kpi(money(f.net), 'الصافي')}</div>
  ${f.user.role === 'doctor' ? `<p>${Object.entries(f.byType).map(([t, x]) => `${TY()[t]}: ${x.n} محاضرة = ${money(x.sum)}`).join(' · ') || 'مفيش محاضرات مسلّمة لسه'}${f.pendingLecs ? ` <span class="mut">· ${f.pendingLecs} محاضرة لسه ماتسلمتش وهتتحسب لما تتسلم</span>` : ''}</p>` : `<p>المرتب: ${money(f.salary)}</p>`}
  ${f.extra.length ? `<p>مستحقات إضافية: ${f.extra.map(x => `${money(x.amount)} (${esc(x.note || '')})`).join('، ')}</p>` : ''}${f.bons.length ? `<p>بونص: ${f.bons.map(x => `${money(x.amount)} (${esc(x.note || '')})`).join('، ')}</p>` : ''}${f.pens.length ? `<p class="red">خصومات: ${f.pens.map(x => `${money(x.amount)} (${esc(x.reason)})`).join('، ')}</p>` : ''}
  ${f.lecs.length ? `<details><summary>تفاصيل المحاضرات (${f.lecs.length})</summary><table class="stack"><tbody>${f.lecs.map(l => `<tr><td>#${l.id} ${esc(l.name)}</td><td>${TY()[l.type]}</td><td class="n">${money(l.price)}</td><td>${fmt(l.delivered_at)}</td></tr>`).join('')}</tbody></table></details>` : ''}
  <h3 style="margin-top:16px">التقفيلات السابقة</h3>${f.settlements.length ? `<table class="stack"><thead><tr><th>الفترة</th><th>النوع</th><th class="n">الصافي</th><th>الدفع</th></tr></thead><tbody>${f.settlements.map(s => `<tr><td>${esc(s.period)}</td><td>${s.kind === 'early' ? 'معجّل' : 'شهري'}</td><td class="n">${money(s.net)}</td><td>${s.paid_at ? `<span class="ok">اتدفع ${fmt(s.paid_at)}</span>` : admin ? `<button class="btn sm g" data-paid="${s.id}">تم الدفع</button>` : 'لسه'}</td></tr>`).join('')}</tbody></table>` : '<p class="mut">مفيش</p>'}`;
}
async function openFinance(id) {
  const f = await api('GET', '/api/finance/' + id);
  modal(`<b>${esc(f.user.name)}</b> <span class="mut">${ROLE[f.user.role]}</span>`, finBody(f, true) + `<div class="panel" style="margin-top:14px"><h3>إضافة</h3><form id="bf" class="row"><select name="what" style="width:auto">${opts([['bonuses', 'بونص'], ['extra', 'مستحق إضافي (زي مرتب متغير)']], 'bonuses')}</select><input name="amount" type="number" step="0.01" placeholder="المبلغ" required style="width:9em"><input name="note" placeholder="ملاحظة" style="flex:1"><button class="btn sm">إضافة</button></form></div>
  <div class="panel"><h3>التقفيل</h3><div class="row"><input id="per" value="${esc(ME.today.slice(0, 7))}" style="width:9em" dir="ltr"><button class="btn a" id="sm">تقفيل شهري (${money(f.net)})</button><button class="btn g" id="se">تقفيل معجّل</button></div><p class="mut">التقفيل بيقفل كل المبالغ اللي فوق، وأي حاجة بعد كده بتدخل في الفترة الجاية.</p></div>`);
  $('#bf').onsubmit = async e => { e.preventDefault(); const x = Object.fromEntries(new FormData(e.target)); await api('POST', '/api/' + x.what, { user_id: id, amount: x.amount, note: x.note }); toast('اتضاف'); openFinance(id); V.finance(); };
  const settle = async kind => { await api('POST', `/api/finance/${id}/settle`, { kind, period: $('#per').value }); toast('اتقفل'); openFinance(id); V.finance(); };
  $('#sm').onclick = () => settle('month'); $('#se').onclick = () => settle('early');
  document.querySelectorAll('[data-paid]').forEach(b => (b.onclick = async () => { await api('PATCH', '/api/settlements/' + b.dataset.paid); toast('اتسجل الدفع'); openFinance(id); }));
}

/* ----- subscriptions (cs/admin) ----- */
V.subs = async () => {
  const [bs, hist] = await Promise.all([api('GET', '/api/batches'), api('GET', '/api/subs')]);
  $('#main').innerHTML = `<h2>تسجيل الاشتراكات</h2><p class="note">كل 7 أيام سجّل عدد اشتراكات كل دفعة من Nerdio. الرقم بيتقارن بالعدد المتوقع للدفعة.</p>
  <form id="sf" class="panel"><label style="max-width:14em">التاريخ<input type="date" name="day" value="${esc(ME.today)}"></label><table class="stack"><thead><tr><th>الدفعة</th><th class="n">آخر رقم</th><th class="n">المتوقع</th><th>العدد الحالي</th></tr></thead><tbody>${bs.map(b => `<tr><td><b dir="ltr">${esc(b.code)}</b> <span class="mut">${esc(b.uni)} · ${esc(b.year)}</span></td><td class="n">${b.subs ?? '—'}</td><td class="n">${b.expected_subs || '—'}</td><td><input type="number" min="0" data-b="${b.id}" style="max-width:8em"></td></tr>`).join('')}</tbody></table><button class="btn a">حفظ الأرقام</button></form>
  <section class="panel"><h3>آخر التسجيلات</h3>${hist.length ? `<table class="stack"><tbody>${hist.slice(0, 60).map(h => `<tr><td dir="ltr">${esc(h.code)}</td><td>${esc(h.day)}</td><td class="n">${h.count}</td></tr>`).join('')}</tbody></table>` : empty('مفيش')}</section>`;
  $('#sf').onsubmit = async e => { e.preventDefault(); const rows = [...document.querySelectorAll('[data-b]')].filter(i => i.value !== '').map(i => ({ batch_id: i.dataset.b, count: i.value })); if (!rows.length) return toast('اكتب رقم واحد على الأقل'); await api('POST', '/api/subs', { day: new FormData(e.target).get('day'), rows }); toast('اتحفظ'); V.subs(); };
};
V.shift = async () => {
  const ns = await api('GET', '/api/shift');
  $('#main').innerHTML = `<h2>تسليم الشيفت</h2><p class="note">قبل ما تخلص شيفتك اكتب لزميلك إيه المفتوح وإيه محتاج متابعة.</p><form id="nf" class="panel"><textarea name="body" required rows="5"></textarea><button class="btn a">حفظ الملاحظة</button></form><section class="panel">${ns.map(n => `<div style="border-bottom:1px solid var(--line);padding:8px 0"><b>${esc(n.name)}</b> <span class="mut">${fmt(n.created_at)}</span><p style="white-space:pre-wrap;margin:4px 0">${esc(n.body)}</p></div>`).join('') || empty('مفيش')}</section>`;
  $('#nf').onsubmit = async e => { e.preventDefault(); await api('POST', '/api/shift', { body: new FormData(e.target).get('body') }); toast('اتحفظت'); V.shift(); };
};

/* ----- account ----- */
V.account = async () => {
  ME = await api('GET', '/api/me');
  let fin = '';
  if (ME.role !== 'admin') { const f = await api('GET', '/api/finance/' + ME.id); fin = `<section class="panel"><h3>حسابي المالي (الفترة الحالية)</h3>${finBody(f, false)}</section>`; }
  $('#main').innerHTML = `<h2>${esc(ME.name)}</h2><p class="note">${esc(ME.email)} · ${ROLE[ME.role]}</p>
  <section class="panel"><h3>بوت تليجرام</h3>${ME.linked ? '<p class="ok">حسابك مربوط بالبوت ✓</p>' : `<p>افتح بوت ${esc(ME.brand)} على تليجرام، ودوس Start، وابعت الكود ده:</p><p style="font-size:22px"><code>${esc(ME.link_code || '')}</code></p>`}</section>
  ${fin}
  <form id="pw" class="panel"><h3>تغيير كلمة المرور</h3><div class="two"><label>الحالية<input type="password" name="old" required></label><label>الجديدة (8 حروف على الأقل)<input type="password" name="new" minlength="8" required></label></div><button class="btn sm">تغيير</button></form>`;
  $('#pw').onsubmit = async e => { e.preventDefault(); await api('POST', '/api/me/password', Object.fromEntries(new FormData(e.target))); e.target.reset(); toast('اتغيرت'); };
};

/* ----- settings (admin) ----- */
let ST = 'users';
V.settings = async () => {
  const tabs = { users: 'المستخدمين', batches: 'الجامعات والدفعات', general: 'إعدادات عامة' };
  let body = '';
  if (ST === 'users') {
    const us = await api('GET', '/api/users');
    body = `<details class="panel"><summary><b>إضافة مستخدم</b></summary><form id="uf" style="margin-top:10px"><div class="two"><label>الاسم<input name="name" required></label><label>الإيميل<input name="email" type="email" dir="ltr" required></label></div><div class="two"><label>الصلاحية<select name="role" id="ur">${opts(Object.entries(ROLE), 'doctor')}</select></label><label>كلمة المرور (8+)<input name="password" minlength="8" required dir="ltr"></label></div><div class="two"><label>الموبايل<input name="phone" dir="ltr"></label><label id="sal">المرتب الشهري<input name="salary" type="number" step="0.01" value="0"></label></div>
    <div id="dcf" class="four"><label>سعر النظري<input type="number" step="0.01" name="price_theory" value="0"></label><label>سعر العملي<input type="number" step="0.01" name="price_practical" value="0"></label><label>سعر المراجعة<input type="number" step="0.01" name="price_revision" value="0"></label><label>الطاقة اليومية<input type="number" name="capacity" value="3"></label></div><button class="btn a">إضافة</button></form></details>
    <div class="panel" style="padding:6px 10px"><table class="stack"><thead><tr><th>الاسم</th><th>الدور</th><th>الإيميل</th><th>البوت</th><th></th></tr></thead><tbody>${us.map(u => `<tr${u.active ? '' : ' style="opacity:.5"'}><td><b>${esc(u.name)}</b>${u.role !== 'doctor' && u.role !== 'admin' ? `<div class="mut">مرتب ${money(u.salary)}</div>` : ''}</td><td>${ROLE[u.role]}</td><td dir="ltr">${esc(u.email)}</td><td>${u.linked ? '<span class="ok">مربوط ✓</span>' : `<code>${esc(u.link_code)}</code>`}</td><td><button class="btn g sm" data-ue="${u.id}">تعديل</button></td></tr>`).join('')}</tbody></table></div>`;
    cache.users = us;
  } else if (ST === 'batches') {
    const [unis, bs, us] = await Promise.all([api('GET', '/api/universities'), api('GET', '/api/batches'), api('GET', '/api/users')]);
    const sups = us.filter(u => u.role === 'supervisor' && u.active).map(u => [u.id, u.name]), cos = us.filter(u => u.role === 'coordinator' && u.active).map(u => [u.id, u.name]);
    cache.sel = { sups, cos };
    body = `<div class="grid2"><details class="panel"><summary><b>إضافة جامعة</b></summary><form id="unf" style="margin-top:10px"><div class="two"><label>الكود<input name="code" required dir="ltr" placeholder="6"></label><label>الاسم<input name="name" required></label></div><button class="btn sm">إضافة</button></form></details>
    <details class="panel"><summary><b>إضافة دفعة</b></summary><form id="bnf" style="margin-top:10px"><div class="two"><label>الجامعة<select name="university_id" required>${opts(unis.map(u => [u.id, u.code + ' · ' + u.name]), '', 'اختار')}</select></label><label>السنة<input name="year" required placeholder="سنة أولى"></label></div><div class="two"><label>رقم السنة في الكود<input name="year_no" required dir="ltr" placeholder="1"></label><label>العدد المتوقع للاشتراكات<input name="expected_subs" type="number" value="0"></label></div><div class="two"><label>المشرف<select name="supervisor_id">${opts(sups, '', '—')}</select></label><label>مسؤول الدفعة<select name="coordinator_id">${opts(cos, '', '—')}</select></label></div><button class="btn sm">إضافة</button></form></details></div>
    <div class="panel" style="padding:6px 10px"><table class="stack"><thead><tr><th>الكود</th><th>الجامعة</th><th>السنة</th><th>المشرف</th><th>المسؤول</th><th class="n">المتوقع</th><th></th></tr></thead><tbody>${bs.map(b => `<tr><td dir="ltr"><b>${esc(b.code)}</b></td><td>${esc(b.uni)}</td><td>${esc(b.year)}</td><td>${esc(b.supervisor || '—')}</td><td>${esc(b.coordinator || '—')}</td><td class="n">${b.expected_subs || '—'}</td><td><button class="btn g sm" data-be="${b.id}">تعديل</button></td></tr>`).join('')}</tbody></table></div>`;
    cache.batches = bs;
  } else {
    const s = await api('GET', '/api/settings');
    const f = (k, l, t = 'number') => `<label>${l}<input name="${k}" type="${t}" value="${esc(s[k])}" ${t === 'number' ? 'step="any"' : ''}></label>`;
    body = `<form id="gf" class="panel"><div class="two">${f('brand', 'الاسم', 'text')}${f('deadline_hours', 'مهلة الدكتور (ساعات)')}${f('remind_hours', 'التذكير قبل النهاية بـ (ساعات)')}${f('upload_minutes', 'مهلة الرفع (دقايق)')}${f('coord_reply_minutes', 'مهلة مسؤول الدفعة في الرد (دقايق)')}${f('cs_reply_minutes', 'مهلة خدمة العملاء (دقايق)')}${f('exam_alert_days', 'تنبيه الامتحان قبلها بـ (أيام)')}${f('repeat_ratio', 'نسبة سعر المعادة (0.5 = النص)')}${f('report_time', 'ميعاد التقرير اليومي', 'time')}${f('backup_time', 'ميعاد الباك أب', 'time')}</div><button class="btn a">حفظ</button></form><div class="panel"><h3>الباك أب</h3><p class="mut">بيتعمل تلقائي كل يوم ويتبعت لقناة تليجرام الخاصة.</p><button class="btn g" id="bk">اعمل باك أب دلوقتي</button></div>`;
  }
  $('#main').innerHTML = `<h2>الإعدادات</h2><div class="tabs">${Object.entries(tabs).map(([k, v]) => `<button data-st="${k}" class="${k === ST ? 'on' : ''}">${v}</button>`).join('')}</div>${body}`;
  document.querySelectorAll('[data-st]').forEach(b => (b.onclick = () => { ST = b.dataset.st; V.settings(); }));
  if ($('#uf')) { const tog = () => { const d = $('#ur').value === 'doctor'; $('#dcf').hidden = !d; $('#sal').hidden = d || $('#ur').value === 'admin'; }; $('#ur').onchange = tog; tog();
    $('#uf').onsubmit = async e => { e.preventDefault(); const r = await api('POST', '/api/users', Object.fromEntries(new FormData(e.target))); toast('اتضاف · كود البوت ' + r.link_code); V.settings(); }; }
  document.querySelectorAll('[data-ue]').forEach(b => (b.onclick = () => {
    const u = cache.users.find(x => x.id === Number(b.dataset.ue));
    modal(`<b>${esc(u.name)}</b>`, `<form id="ef"><div class="two"><label>الاسم<input name="name" value="${esc(u.name)}"></label><label>الإيميل<input name="email" dir="ltr" value="${esc(u.email)}"></label></div><div class="two"><label>الموبايل<input name="phone" dir="ltr" value="${esc(u.phone || '')}"></label>${u.role !== 'doctor' ? `<label>المرتب<input name="salary" type="number" step="0.01" value="${u.salary}"></label>` : ''}</div><label>كلمة مرور جديدة (سيبها فاضية لو مش عايز تغيّر)<input name="password" dir="ltr" minlength="8"></label><label class="chk"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> الحساب شغال</label><label class="chk"><input type="checkbox" name="new_code"> كود ربط جديد (بيفك ربط البوت الحالي)</label><button class="btn">حفظ</button></form>`);
    $('#ef').onsubmit = async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); f.active = f.active ? 1 : 0; f.new_code = !!f.new_code; if (!f.password) delete f.password; await api('PATCH', '/api/users/' + u.id, f); dlg.close(); toast('اتحفظ'); V.settings(); };
  }));
  if ($('#unf')) $('#unf').onsubmit = async e => { e.preventDefault(); await api('POST', '/api/universities', Object.fromEntries(new FormData(e.target))); toast('اتضافت'); V.settings(); };
  if ($('#bnf')) $('#bnf').onsubmit = async e => { e.preventDefault(); await api('POST', '/api/batches', Object.fromEntries(new FormData(e.target))); toast('اتضافت'); V.settings(); };
  document.querySelectorAll('[data-be]').forEach(b => (b.onclick = () => {
    const bt = cache.batches.find(x => x.id === Number(b.dataset.be)), { sups, cos } = cache.sel;
    modal(`<b dir="ltr">${esc(bt.code)}</b>`, `<form id="ef"><div class="two"><label>الكود<input name="code" dir="ltr" value="${esc(bt.code)}"></label><label>السنة<input name="year" value="${esc(bt.year)}"></label></div><div class="two"><label>المشرف<select name="supervisor_id">${opts(sups, bt.supervisor_id, '—')}</select></label><label>مسؤول الدفعة<select name="coordinator_id">${opts(cos, bt.coordinator_id, '—')}</select></label></div><label>العدد المتوقع للاشتراكات<input name="expected_subs" type="number" value="${bt.expected_subs}"></label><label class="chk"><input type="checkbox" name="active" checked> الدفعة شغالة</label><button class="btn">حفظ</button></form>`);
    $('#ef').onsubmit = async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); f.active = f.active ? 1 : 0; await api('PATCH', '/api/batches/' + bt.id, f); dlg.close(); toast('اتحفظ'); V.settings(); };
  }));
  if ($('#gf')) $('#gf').onsubmit = async e => { e.preventDefault(); await api('PUT', '/api/settings', Object.fromEntries(new FormData(e.target))); toast('اتحفظ'); ME = await api('GET', '/api/me'); };
  if ($('#bk')) $('#bk').onclick = async () => { const r = await api('POST', '/api/backup'); toast(r.ok ? 'الباك أب اتعمل' : 'حصلت مشكلة'); };
};

boot();
setInterval(() => { if (ME && !dlg.open && !document.activeElement?.matches('input,textarea,select') && ['home', 'lectures', 'tickets'].includes(view)) render(); }, 60000);
}
