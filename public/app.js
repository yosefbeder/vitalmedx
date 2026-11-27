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
  admin: [['home', 'لوحة التحكم'], ['unis', 'الجامعات'], ['lectures', 'المحاضرات'], ['tickets', 'الأسئلة والمشاكل'], ['doctors', 'الدكاترة'], ['team', 'الفريق'], ['ranking', 'الترتيب'], ['reports', 'التقارير'], ['penalties', 'العقوبات'], ['finance', 'الحسابات'], ['subs', 'الاشتراكات'], ['audit', 'سجل العمليات'], ['settings', 'الإعدادات'], ['chats', 'المحادثات'], ['account', 'حسابي']],
  supervisor: [['home', 'لوحة التحكم'], ['unis', 'دفعاتي'], ['lectures', 'المحاضرات'], ['tickets', 'الأسئلة والمشاكل'], ['doctors', 'الدكاترة'], ['team', 'التيم'], ['reports', 'التقرير اليومي'], ['penalties', 'العقوبات'], ['chats', 'المحادثات'], ['account', 'حسابي']],
  coordinator: [['home', 'لوحة التحكم'], ['checklist', 'مهام اليوم'], ['lectures', 'المحاضرات'], ['tickets', 'الأسئلة والمشاكل'], ['unis', 'دفعاتي'], ['doctors', 'الدكاترة'], ['penalties', 'العقوبات'], ['chats', 'المحادثات'], ['account', 'حسابي']],
  cs: [['tickets', 'التذاكر'], ['subs', 'الاشتراكات'], ['chats', 'المحادثات'], ['account', 'حسابي']],
  doctor: [['home', 'مهامي'], ['myq', 'الأسئلة'], ['penalties', 'القرارات'], ['chats', 'المحادثات'], ['account', 'حسابي']],
};
const TY = () => ME.types;
const PRI = { 0: ['غير مهم', 'pd'], 1: ['عادي', 'rv'], 2: ['مهم', 'warn'], 3: ['مهم جداً', 'bad'] };
const ORD = ['', 'الأول', 'التاني', 'التالت', 'الرابع', 'الخامس', 'السادس', 'السابع', 'التامن', 'التاسع', 'العاشر'];
async function rankCard() { try { const r = await api('GET', '/api/myrank'); if (!r.rank) return ''; return `<div class="panel" style="display:flex;gap:14px;align-items:center"><b style="font-size:34px;line-height:1">${r.rank}</b><div><b>إنت ${r.rank <= 10 ? 'في المركز ' + ORD[r.rank] : 'في المركز رقم ' + r.rank}</b><div class="mut">من ${r.of} في نفس دورك · ترتيب شهر ${esc(r.month)}</div></div></div>`; } catch { return ''; } }
const LS = { late: ['متأخرة', 'bad'], progress: ['قيد التنفيذ', 'pd'], review: ['تحت المراجعة', 'rv'], upload: ['مستنية رفع', 'warn'], done: ['مكتملة', 'ok'] };
const FS = { pending: ['قيد التنفيذ', 'pd'], overdue: ['متأخر – لم يُسلَّم', 'bad'], review: ['تحت المراجعة', 'rv'], approved: ['معتمد', 'ok'] };
function fcell(l, k) {
  const st = l[k + '_state'], at = k === 'v' ? l.video_at : l.q_at; let sub;
  if (st === 'na') return pill('معفي', 'pd') + '<div class="mut">إعفاء ملف الأسئلة</div>';
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
$('#forgot').onclick = e => { e.preventDefault(); $('#lf').hidden = true; $('#ff').hidden = false; $('#ff').email.value = $('#lf').email.value; };
$('#fback').onclick = e => { e.preventDefault(); $('#ff').hidden = true; $('#lf').hidden = false; $('#fstep2').hidden = true; $('#fbtn').textContent = 'ابعتلي الكود'; };
$('#ff').addEventListener('submit', async e => {
  e.preventDefault(); const f = new FormData(e.target); $('#ferr').textContent = '';
  try {
    if ($('#fstep2').hidden) { const r = await api('POST', '/api/forgot', { email: f.get('email') }); $('#fmsg').textContent = r.message; $('#fstep2').hidden = false; $('#fbtn').textContent = 'غيّر كلمة السر'; return; }
    await api('POST', '/api/forgot/reset', { email: f.get('email'), code: f.get('code'), pass: f.get('pass') });
    $('#ff').hidden = true; $('#lf').hidden = false; $('#lf').email.value = f.get('email'); $('#lerr').textContent = ''; toast('كلمة السر اتغيرت ✓ ادخل بيها دلوقتي');
  } catch (err) { $('#ferr').textContent = err.message; }
});
$('#logout').onclick = async () => { await api('POST', '/api/logout'); showLogin(); };
$('#bell').onclick = () => openAlerts();
async function boot() {
  try { ME = await api('GET', '/api/me'); } catch { return showLogin(); }
  document.querySelectorAll('.brandname').forEach(b => (b.textContent = ME.brand)); document.title = ME.brand;
  $('#login').hidden = true; $('#app').hidden = false;
  const h = location.hash.slice(1); view = NAV[ME.role].some(n => n[0] === h) ? h : NAV[ME.role][0][0];
  let ib = document.getElementById('impbar'); if (ib) ib.remove();
  if (ME.impersonated_by) { ib = document.createElement('div'); ib.id = 'impbar'; ib.style.cssText = 'z-index:20;background:#9a6408;color:#fff;padding:8px 14px;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap'; ib.innerHTML = `<span>إنت داخل على حساب <b>${esc(ME.name)}</b> (${ROLE[ME.role]}) بصلاحياته. أي حاجة تعملها هتتسجل باسمه.</span><button class="btn sm" style="background:#fff;color:#000;border-color:#fff" id="impstop">رجوع لحسابي</button>`; document.querySelector('.content').prepend(ib); $('#impstop').onclick = async () => { await api('POST', '/api/impersonate-stop'); location.hash = 'settings'; await boot(); }; }
  $('#mebox').innerHTML = `<b>${esc(ME.name)}</b><small>${ROLE[ME.role]} · إصدار 1.8.1</small>`;
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
  return list.length ? `<table class="stack"><tbody>${list.map(a => `<tr><td>${esc(a.text)}</td><td class="n">${a.lecture_id ? `<button class="btn g sm" data-lec="${a.lecture_id}">فتح</button>` : a.ticket_id ? `<button class="btn g sm" data-tk="${a.ticket_id}">فتح</button>` : a.penalty_id ? '<a class="btn g sm" href="#penalties" data-close style="display:inline-flex;align-items:center;text-decoration:none">عرض</a>' : a.user_id ? `<button class="btn g sm" data-finu="${a.user_id}">عرض</button>` : ''}</td></tr>`).join('')}</tbody></table>` : empty('مفيش تنبيهات');
}
function openAlerts() { modal(`<b>التنبيهات (${(cache.alerts || []).length})</b>`, alertRows(cache.alerts || [])); }
document.addEventListener('click', e => {
  const l = e.target.closest('[data-lec]'); if (l) { openLecture(Number(l.dataset.lec)); return; }
  const t = e.target.closest('[data-tk]'); if (t) { openTicket(Number(t.dataset.tk)); return; }
  const d = e.target.closest('[data-doc]'); if (d) { openDoctor(Number(d.dataset.doc)); return; }
  const im = e.target.closest('[data-imp2]'); if (im) { api('POST', '/api/impersonate/' + im.dataset.imp2).then(() => { dlg.close(); location.hash = ''; boot(); }); return; }
  const fu = e.target.closest('[data-finu]'); if (fu) openFinance(Number(fu.dataset.finu));
});

/* ================= views ================= */
const V = {};

V.home = async () => {
  const h = await api('GET', '/api/home');
  if (ME.role === 'doctor') return await doctorHome(h);
  const s = h.summary, late = s.lateNow;
  let html = `<h2>${late ? `${late} محاضرة متأخرة دلوقتي محتاجة متابعة` : 'كل المحاضرات ماشية في مواعيدها'}</h2><p class="note">أرقام النهارده · ${esc(ME.today)}</p>
  <div class="kpis">${kpi(s.sent, 'اتبعتت النهارده')}${kpi(s.videos, 'فيديوهات اتسلمت')}${kpi(s.qfiles, 'ملفات أسئلة اتسلمت')}${kpi(s.uploaded, 'اترفعت')}${kpi(late, 'متأخرة الآن', late)}${kpi(s.toUpload, 'مستنية رفع', s.toUpload)}${kpi(s.questions, 'أسئلة جديدة')}${kpi(s.ticketsLate, 'تذاكر عدّت المهلة', s.ticketsLate)}${kpi(s.problemsOpen, 'مشاكل مفتوحة', s.problemsOpen)}</div>`;
  if (ME.role !== 'admin') html += await rankCard();
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
async function doctorHome(h) {
  const s = h.stats, sc = s.score, rc = await rankCard();
  $('#main').innerHTML = `<h2>أهلاً ${esc(ME.name)}</h2><p class="note">المحاضرات بتوصلك وبتسلّمها على البوت. هنا تقدر تتابع مهامك وتقييمك.</p>
  ${rc}<div class="kpis">${kpi(sc.total, 'تقييمك من 100', sc.total < 70)}${kpi(s.assigned, 'كل المحاضرات')}${kpi(s.delivered, 'سلّمتها')}${kpi(s.lateNow, 'متأخرة الآن', s.lateNow)}${kpi(pct(s.compliance), 'التزامك بالمواعيد')}${kpi(`${s.sentToday}/${s.capacity}`, 'النهارده من طاقتك')}</div>
  <div class="grid2"><section class="panel"><h3>المحاضرات المفتوحة</h3><div id="dl"></div></section><section class="panel"><h3>تفاصيل التقييم</h3>${meter('الالتزام بالموعد', sc.dl, 35, `${Math.round(sc.dl)}/35`)}${meter('جودة الفيديو', sc.video ?? 0, 40, sc.video == null ? '—' : `${Math.round(sc.video)}/40`)}${meter('جودة الأسئلة', sc.q ?? 0, 10, sc.q == null ? '—' : `${Math.round(sc.q)}/10`)}${meter('التعليمات', sc.instr ?? 0, 10, sc.instr == null ? '—' : `${Math.round(sc.instr)}/10`)}${meter('التواصل', sc.comm ?? 0, 5, sc.comm == null ? '—' : `${Math.round(sc.comm)}/5`)}<p class="mut">${ME.linked ? 'حسابك مربوط بالبوت ✓' : 'حسابك لسه مش مربوط بالبوت. ادخل "حسابي" وخد الكود.'}</p></section></div>
  <section class="panel"><h3>آخر المحاضرات</h3><div id="dall"></div></section>`;
  api('GET', '/api/lectures?limit=60').then(ls => {
    const open = ls.filter(l => !(l.video_at && l.q_at)).sort((a, b) => (a.queue_pos ?? 1e9) - (b.queue_pos ?? 1e9) || a.sent_at - b.sent_at);
    $('#dl').innerHTML = open.length ? `<table class="stack"><thead><tr><th>المحاضرة</th><th>الفيديو</th><th>الأسئلة</th></tr></thead><tbody>${open.map((l, i) => `<tr><td><b>${i + 1})</b> #${l.id} ${esc(l.name)}<div class="mut">${TY()[l.type]} · ${money(l.price)}</div></td><td>${fcell(l, 'v')}</td><td>${fcell(l, 'q')}</td></tr>`).join('')}</tbody></table>` : empty('مفيش محاضرات مفتوحة ✓');
    $('#dall').innerHTML = `<table class="stack"><thead><tr><th>المحاضرة</th><th>النوع</th><th class="n">السعر</th><th>الحالة</th><th>اتبعتت</th></tr></thead><tbody>${ls.map(l => `<tr><td>#${l.id} ${esc(l.name)}</td><td>${TY()[l.type]}</td><td class="n">${money(l.price)}</td><td>${pill(...LS[l.state])}</td><td>${fmt(l.sent_at)}</td></tr>`).join('')}</tbody></table>`;
  });
}

/* ----- universities / batches ----- */
function batchTable(bs, compact) {
  if (!bs.length) return empty('مفيش دفعات');
  const canExam = ['admin', 'coordinator', 'supervisor'].includes(ME.role);
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
    const bt = cache.batches.find(x => x.id === Number(b.dataset.exam)), ex = bt.exams || [];
    modal(`<b>امتحانات ${esc(bt.code)}</b>`, `${ex.length ? `<table class="stack"><thead><tr><th>التاريخ</th><th>الامتحان</th><th></th></tr></thead><tbody>${ex.map((e, i) => `<tr><td dir="ltr">${esc(e.date)}${i === 0 ? ' <span class="p pd">الأقرب</span>' : ''}</td><td>${esc(e.name || '—')}</td><td><button class="btn g sm" data-exdel="${e.id}">مسح</button></td></tr>`).join('')}</tbody></table>` : '<p class="mut">مفيش امتحانات جاية متسجلة.</p>'}
    <form id="ef" class="panel" style="margin-top:10px"><h3>إضافة امتحان</h3><div class="two"><label>التاريخ<input type="date" name="date" required></label><label>اسم الامتحان أو المادة<input name="name" placeholder="مثلاً: باطنة ميدتيرم"></label></div><button class="btn a">إضافة</button></form>
    <p class="mut">تنبيه المراجعات بيشتغل على أقرب امتحان، والامتحان اللي فات بيختفي لوحده.</p>`);
    $('#ef').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target); await api('POST', `/api/batches/${bt.id}/exams`, { date: f.get('date'), name: f.get('name') }); dlg.close(); toast('الامتحان اتسجل ✓'); render(); };
    document.querySelectorAll('[data-exdel]').forEach(x => (x.onclick = async () => { await api('DELETE', '/api/exams/' + x.dataset.exdel); dlg.close(); toast('اتمسح'); render(); }));
  }));
}

/* ----- chats ----- */
V.chats = async () => {
  const boss = ['admin', 'supervisor'].includes(ME.role), r = await api('GET', '/api/chats' + (boss ? '?all=1' : ''));
  const row = c => `<button class="card" data-chat="${c.id}" style="text-align:right;width:100%;margin-bottom:8px"><div class="row sp"><b>${esc(c.name)}</b>${c.unread ? `<span class="p bad">${c.unread} جديدة</span>` : ''}</div><div class="mut">${ROLE[c.role]}${c.linked ? '' : ' · مش رابط البوت'}</div>${c.last ? `<div class="mut" style="margin-top:4px">${c.last.mine ? 'انت: ' : ''}${esc(c.last.body.slice(0, 70))} · ${fmt(c.last.at)}</div>` : ''}</button>`;
  $('#main').innerHTML = `<h2>المحادثات</h2><p class="note">ابعت رسالة لأي حد من هنا أو من البوت (/msg). الرسالة بتوصله على البوت، ولما يعمل Reply عليها ردّه بيرجعلك هنا وعلى البوت.</p>
  <div class="panel" style="padding:8px">${r.contacts.length ? r.contacts.map(row).join('') : empty('مفيش حد تقدر تكلمه')}</div>
  ${boss && r.others.length ? `<h3>محادثات الفريق</h3><div class="panel" style="padding:6px 10px"><table class="stack"><thead><tr><th>بين</th><th>آخر رسالة</th><th class="n">عدد</th></tr></thead><tbody>${r.others.map(o => `<tr class="click" data-pair="${o.a}:${o.b}"><td>${esc(o.a_name)} (${ROLE[o.a_role] || ''}) ↔ ${esc(o.b_name)} (${ROLE[o.b_role] || ''})</td><td>${fmt(o.at)}</td><td class="n">${o.n}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  document.querySelectorAll('[data-chat]').forEach(b => (b.onclick = () => openChat(ME.id, Number(b.dataset.chat), r.contacts.find(c => c.id === Number(b.dataset.chat)))));
  document.querySelectorAll('[data-pair]').forEach(b => (b.onclick = () => { const [a, c] = b.dataset.pair.split(':').map(Number); const o = r.others.find(x => x.a === a && x.b === c); openChat(a, c, null, o); }));
};
async function openChat(a, b, peer, pairInfo) {
  const ms = await api('GET', `/api/chats/${a}/${b}`), mine = a === ME.id;
  const title = mine ? `${esc(peer.name)} · ${ROLE[peer.role]}` : `${esc(pairInfo.a_name)} ↔ ${esc(pairInfo.b_name)}`;
  const bubble = m => { const me = m.from_id === a; return `<div style="display:flex;justify-content:${me ? 'flex-start' : 'flex-end'};margin:6px 0"><div style="max-width:80%;padding:8px 10px;border-radius:12px;background:${me ? 'var(--accent-soft, #e3f3f1)' : 'var(--panel-2, #f1f0ec)'}"><div style="white-space:pre-wrap">${esc(m.body || '')}</div>${m.has_file ? media(`/api/messages/${m.id}/file`, m.mime || ({ voice: 'audio/ogg', photo: 'image/jpeg', video: 'video/mp4' }[m.file_kind] || ''), m.name) : ''}<div class="mut" style="font-size:11px;margin-top:2px">${mine ? (me ? 'انت' : esc(peer.name)) : (m.from_id === pairInfo.a ? esc(pairInfo.a_name) : esc(pairInfo.b_name))} · ${fmt(m.created_at)}</div></div></div>`; };
  modal(`<b>${title}</b>`, `<div id="cbox" style="max-height:55vh;overflow:auto">${ms.length ? ms.map(bubble).join('') : '<p class="mut">مفيش رسايل لسه.</p>'}</div>
    ${mine ? `<form id="cf2" style="margin-top:10px"><textarea name="body" placeholder="اكتب رسالتك" rows="2"></textarea><div class="row sp"><input type="file" name="file" style="max-width:60%"><button class="btn a">إرسال</button></div>${peer.linked ? '' : '<p class="mut">مش رابط البوت: هيشوف الرسالة في اللوحة بس.</p>'}</form>` : '<p class="mut">انت بتتابع المحادثة دي بس.</p>'}`);
  const box = $('#cbox'); box.scrollTop = box.scrollHeight;
  if (mine) $('#cf2').onsubmit = async e => { e.preventDefault(); const fd = new FormData(e.target); if (!String(fd.get('body')).trim() && !(fd.get('file') && fd.get('file').size)) return toast('اكتب الرسالة'); if (!(fd.get('file') && fd.get('file').size)) fd.delete('file');
    const btn = e.target.querySelector('.btn.a'); btn.disabled = true; try { const r = await api('POST', '/api/chats/' + b, fd); toast(r.delivered ? 'اتبعتت ✓' : 'اتسجلت (مش رابط البوت)'); openChat(a, b, peer); } catch { btn.disabled = false; } };
}

/* ----- lectures ----- */
const LF = { state: '', batch: '', doctor: '', type: '', q: '', priority: '', sort: '' };
V.lectures = async () => {
  const [bs, ds] = await Promise.all([api('GET', '/api/batches'), api('GET', '/api/doctors')]); cache.batches = bs; cache.doctors = ds;
  const canSend = ['admin', 'coordinator', 'supervisor'].includes(ME.role);
  $('#main').innerHTML = `<div class="row sp"><h2>المحاضرات</h2>${canSend ? '<button class="btn a" id="newlec">+ إرسال محاضرة</button>' : ''}</div>
  <p class="note">كل محاضرة ليها تايمر ${esc(ME.settings.deadline_hours)} ساعة للفيديو وتايمر منفصل لملف الأسئلة، والرفع خلال ${esc(ME.settings.upload_minutes)} دقيقة من الاعتماد.</p>
  <div class="filters"><input id="fq" placeholder="بحث بالاسم أو الرقم" value="${esc(LF.q)}"><select id="fs">${opts(Object.entries(LS).map(([k, v]) => [k, v[0]]), LF.state, 'كل الحالات')}</select><select id="fb">${opts(bs.map(b => [b.id, b.code + ' · ' + b.uni]), LF.batch, 'كل الدفعات')}</select><select id="fd">${opts(ds.map(d => [d.id, d.name]), LF.doctor, 'كل الدكاترة')}</select><select id="ft">${opts(Object.entries(TY()), LF.type, 'كل الأنواع')}</select><select id="fp">${opts(Object.entries(PRI).map(([k, v]) => [k, v[0]]).reverse(), LF.priority, 'كل الأولويات')}</select><select id="fo">${opts([['priority', 'الأهم أولاً']], LF.sort, 'الأحدث أولاً')}</select></div><div id="lt"></div>`;
  const load = async () => { const q = new URLSearchParams(Object.entries(LF).filter(([, v]) => v)); const ls = await api('GET', '/api/lectures?' + q); $('#lt').innerHTML = `<p class="mut">${ls.length} محاضرة</p><div class="panel" style="padding:6px 10px">${lecTable(ls)}</div>`; };
  const bind = (id, k, ev = 'change') => ($(id)['on' + ev] = () => { LF[k] = $(id).value; load(); });
  bind('#fs', 'state'); bind('#fb', 'batch'); bind('#fd', 'doctor'); bind('#ft', 'type'); bind('#fp', 'priority'); bind('#fo', 'sort');
  let tm; $('#fq').oninput = () => { clearTimeout(tm); tm = setTimeout(() => { LF.q = $('#fq').value; load(); }, 300); };
  if (canSend) $('#newlec').onclick = () => sendLectureForm();
  load();
};
function lecTable(ls) {
  if (!ls.length) return empty('مفيش محاضرات');
  return `<table class="stack"><thead><tr><th>#</th><th>المحاضرة</th><th>الدكتور</th><th>النوع</th><th>الفيديو</th><th>الأسئلة</th><th>الحالة</th><th></th></tr></thead><tbody>${ls.map(l => `<tr><td><b>${l.id}</b><div class="mut">${fmt(l.sent_at)}</div></td><td>${esc(l.name)}<div class="mut"><span dir="ltr">${esc(l.batch_code || '')}</span> · ${esc(l.coordinator || '')}</div></td><td>${esc(l.doctor)}</td><td>${esc(l.type_label || TY()[l.type])}<div class="mut">${money(l.price)}</div></td><td>${fcell(l, 'v')}</td><td>${fcell(l, 'q')}</td><td>${pill(...LS[l.state])}${l.priority != null && l.priority !== 1 ? `<div style="margin-top:4px">${pill(...PRI[l.priority])}</div>` : ''}${l.excused ? '<div class="mut amber">مستثناة من التأخير</div>' : ''}${l.upload_late ? '<div class="mut red">الرفع اتأخر</div>' : ''}</td><td><button class="btn g sm" data-lec="${l.id}">فتح</button></td></tr>`).join('')}</tbody></table>`;
}
function sendLectureForm() {
  const bs = cache.batches, ds = cache.doctors;
  modal('<b>إرسال محاضرة جديدة</b>', `<form id="sf"><div class="two"><label>الدفعة<select name="batch_id" id="sb" required>${opts(bs.map(b => [b.id, b.code + ' · ' + b.uni + ' ' + b.year]), '', 'اختار الدفعة')}</select></label><label>الدكتور<select name="doctor_id" id="sd" required>${opts(ds.map(d => [d.id, d.name + (d.linked ? '' : ' (مش مربوط بالبوت)')]), '', 'اختار الدكتور')}</select></label></div>
  <p class="mut" id="cap"></p><label>الأولوية (مش بتظهر للدكتور)<select name="priority">${opts(Object.entries(PRI).map(([k, v]) => [k, v[0]]).reverse(), '1')}</select></label><div class="two"><label>نوع الشرح<select name="kind" id="sk">${opts(Object.entries(ME.kinds || { new: 'محاضرة جديدة', continue: 'استكمال شرح', repeat: 'معادة' }), 'new')}</select></label><label>النوع<select name="type" id="st">${opts(Object.entries(TY()), 'theory')}</select></label></div><label>السعر<input name="price" id="sp" type="number" step="0.01" min="0" required></label><p class="mut" id="sph"></p>
  <div id="scov" hidden class="panel" style="padding:8px 12px"><b>المراجعة على أنهي محاضرات؟</b><div id="scl" class="mut">اختار الدفعة الأول</div></div>
  <label>اسم المحاضرة<input name="name" required dir="auto" placeholder="Anatomy – Lec 12: Thorax"></label>
  <div class="two"><label>ملف المحاضرة PDF<input type="file" name="lec" accept="application/pdf,.pdf"></label><label>مرجع الأسئلة (اختياري)<input type="file" name="qsrc"></label></div>
  <label class="chk"><input type="checkbox" name="no_q" value="1"> إعفاء ملف الأسئلة (المحاضرة دي مالهاش ملف أسئلة)</label><p class="mut">الدكتور هيشوف اسم المحاضرة ونوعها وسعرها والملفات بس، من غير اسم الجامعة أو الكود.</p><button class="btn a wide">إرسال للدكتور عبر البوت</button></form>`);
  const upd = () => {
    const d = ds.find(x => x.id === Number($('#sd').value)), t = $('#st').value, rep = $('#sk').value === 'repeat';
    $('#sph').textContent = rep ? 'المعادة: اكتب السعر بإيدك.' : '';
    if (rep) { if (!$('#sp').dataset.manual) $('#sp').value = ''; } else if (d) $('#sp').value = d['price_' + t] ?? 0;
    if (!d) { $('#cap').textContent = ''; return; }
    const s = d.stats; $('#cap').innerHTML = `اتبعتله النهارده ${s.sentToday} من طاقته ${s.capacity}${s.sentToday >= s.capacity ? ' · <span class="red">وصل لطاقته</span>' : ''} · متأخر الآن ${s.lateNow}`;
  };
  const covers = async () => { const rv = $('#st').value === 'revision'; $('#scov').hidden = !rv; if (!rv || !$('#sb').value) return;
    const ls = (await api('GET', '/api/lectures?limit=200&batch=' + $('#sb').value)).filter(l => l.type !== 'revision');
    $('#scl').innerHTML = ls.length ? ls.map(l => `<label class="chk" style="margin:4px 0"><input type="checkbox" data-cov="${l.id}"> ${esc(l.name)} <span class="mut">· ${esc(l.doctor)}</span></label>`).join('') : 'مفيش محاضرات في الدفعة دي لسه'; };
  $('#sb').onchange = covers; $('#st').addEventListener('change', covers);
  $('#sd').onchange = upd; $('#st').onchange = upd; $('#sk').onchange = () => { $('#sp').dataset.manual = ''; upd(); }; $('#sp').oninput = () => { $('#sp').dataset.manual = $('#sk').value === 'repeat' ? '1' : ''; };
  $('#sf').onsubmit = async e => {
    e.preventDefault(); const btn = e.target.querySelector('button'); btn.disabled = true;
    const fd = new FormData(e.target); if ($('#st').value === 'revision') fd.set('covers', [...document.querySelectorAll('[data-cov]:checked')].map(x => x.dataset.cov).join(','));
    try { const r = await api('POST', '/api/lectures', fd); dlg.close(); toast(`اتبعتت · #${r.id}${r.delivered_to_bot ? '' : ' (الدكتور مش مربوط بالبوت، الملفات مااتبعتتش)'}${r.over_capacity ? ' · فوق طاقته' : ''}`); render(); } catch { btn.disabled = false; }
  };
}
async function openLecture(id) {
  const l = await api('GET', '/api/lectures/' + id), coord = ['admin', 'coordinator', 'supervisor'].includes(ME.role), staff = coord, boss = ['admin', 'supervisor'].includes(ME.role), canPri = staff || ME.role === 'supervisor';
  const both = l.video_at && l.q_at, approved = l.video_ok_at && l.q_ok_at;
  const log = [[l.sent_at, 'اتبعتت للدكتور عبر البوت'], l.video_at && [l.video_at, 'الفيديو اتسلم' + (l.v_late ? ' (متأخر)' : '')], l.video_ok_at && [l.video_ok_at, 'الفيديو اتعتمد' + (l.ok_by_name ? ` (بواسطة ${l.ok_by_name})` : '')], l.q_at && [l.q_at, 'ملف الأسئلة اتسلم' + (l.q_late ? ' (متأخر)' : '')], l.q_ok_at && [l.q_ok_at, 'ملف الأسئلة اتعتمد' + (l.ok_by_name ? ` (بواسطة ${l.ok_by_name})` : '')], l.uploaded_at && [l.uploaded_at, 'اترفعت على Nerdio والقناة' + (l.uploaded_by_name ? ` (بواسطة ${l.uploaded_by_name})` : '') + (l.upload_late ? ` · متأخر على المسؤول ${l.coordinator || ''}${l.upload_both_late ? ' والمشرف' : ''}` : '')], ...(l.price_log || []).map(p => [p.at, `السعر اتغير من ${money(p.old)} لـ ${money(p.new)} (${p.by_name})`])].filter(Boolean).sort((a, b) => a[0] - b[0]);
  const ni = (n, lab, m) => `<label>${lab} (من ${m})<input type="number" name="${n}" min="0" max="${m}" value="${l[n] ?? ''}" ${approved ? '' : 'disabled'}></label>`;
  modal(`<b>#${l.id}</b> ${pill(...LS[l.state])}<div>${esc(l.name)}</div>`, `<p class="mut">${l.batch_code ? `<span dir="ltr">${esc(l.batch_code)}</span> · ${esc(l.university)} ${esc(l.batch_year)} · ` : ''}${esc(l.doctor)} · ${esc(l.type_label || TY()[l.type])}${l.covers_names && l.covers_names.length ? ` · على: ${esc(l.covers_names.join('، '))}` : ''} · السعر ${money(l.price)}${l.coordinator ? ' · ' + esc(l.coordinator) : ''}</p>
  <div class="two"><div class="panel"><h3>الفيديو</h3>${fcell(l, 'v')}</div><div class="panel"><h3>ملف الأسئلة</h3>${fcell(l, 'q')}</div></div>
  ${canPri ? `<div class="panel"><div class="two"><label>الأولوية (مش بتظهر للدكتور)<select id="lpri">${opts(Object.entries(PRI).map(([k, v]) => [k, v[0]]).reverse(), l.priority)}</select></label>${boss ? `<div>${l.excused ? `<p class="amber"><b>مستثناة من التأخير</b>${l.excuse_note ? '<br>' + esc(l.excuse_note) : ''}</p><button class="btn g sm" id="unex">إلغاء الاستثناء</button>` : `<p class="mut">لو قدّمت عليها محاضرات تانية فوق طاقة الدكتور، استثنيها من التأخير.</p><button class="btn g sm" id="exl">استثناء من التأخير</button>`}</div>` : ''}</div></div>` : ''}
  <h3>سجل العمليات</h3><ul class="log">${log.map(([t, x]) => `<li><span class="mut">${fmt(t)}</span><br>${esc(x)}</li>`).join('')}</ul>
  ${staff ? `<div class="row" style="margin:14px 0">${(l.video_at || l.q_at) ? '<button class="btn g sm" id="fw">ابعتلي الملفات على تليجرام</button>' : ''}${coord && !l.settlement_id ? '<button class="btn g sm" id="pr">تعديل السعر</button>' : ''}${!l.q_at && !l.no_q ? '<button class="btn g sm" id="exq">إعفاء ملف الأسئلة</button>' : ''}${coord && l.no_q && !l.settlement_id ? '<button class="btn g sm" id="unexq">إلغاء إعفاء ملف الأسئلة</button>' : ''}${ME.role === 'admin' && !l.settlement_id ? '<button class="btn sm r" id="cx">مسح المحاضرة</button>' : ''}</div>
  <form id="af" class="panel"><h3>الاعتماد</h3>${l.video_at && !l.video_ok_at ? '<label class="chk"><input type="checkbox" name="video"> اعتماد الفيديو</label>' : ''}${l.q_at && !l.q_ok_at ? '<label class="chk"><input type="checkbox" name="q"> اعتماد ملف الأسئلة</label>' : ''}${!both ? '<p class="mut">المحاضرة مش هتتقفل غير لما الفيديو والأسئلة يوصلوا ويتعتمدوا.</p>' : ''}${(l.video_at && !l.video_ok_at) || (l.q_at && !l.q_ok_at) ? '<button class="btn sm">اعتماد</button>' : approved ? '<p class="ok">الاتنين معتمدين ✓</p>' : ''}</form>
  <form id="rf" class="panel"><h3>التقييم</h3><p class="mut">الالتزام بالموعد (35) بيتحسب لوحده.${approved ? '' : ' التقييم بيتفتح بعد الاعتماد.'}</p><div class="four">${ni('r_video', 'جودة الفيديو', 40)}${ni('r_q', 'جودة الأسئلة', 10)}${ni('r_instr', 'التعليمات', 10)}${ni('r_comm', 'التواصل', 5)}</div>${approved ? '<button class="btn sm">حفظ التقييم</button>' : ''}</form>
  ${approved ? `<div class="panel"><h3>الرفع</h3>${l.uploaded_at ? `<p class="ok">اترفعت ${fmt(l.uploaded_at)} ✓</p>` : `${ME.role === 'supervisor' && l.upload_late ? `<p class="red">المسؤول ${esc(l.coordinator || '')} اتأخر في الرفع. لو رفعتها انت، هتتسجل باسمك والتأخير هيفضل عليه.</p>` : ''}<p class="mut">ارفعها على Nerdio وقناة الدفعة وبعدين دوس هنا.</p><button class="btn a" id="up">تم الرفع</button>`}</div>` : ''}` : ''}`);
  const act = async (b, msg) => { await api('PATCH', '/api/lectures/' + id, b); toast(msg); openLecture(id); render(); };
  if ($('#lpri')) $('#lpri').onchange = () => act({ action: 'priority', priority: $('#lpri').value }, 'الأولوية اتغيرت');
  if ($('#unex')) $('#unex').onclick = () => act({ action: 'unexcuse' }, 'الاستثناء اتلغى');
  if ($('#exl')) $('#exl').onclick = () => { modal(`<b>استثناء #${l.id} من التأخير</b>`, '<form id="exf"><label>السبب<input name="note" placeholder="مثلاً: اتقدم عليها محاضرات مستعجلة"></label><button class="btn">استثناء</button></form>'); $('#exf').onsubmit = e => { e.preventDefault(); act({ action: 'excuse', note: new FormData(e.target).get('note') }, 'اتستثنت من التأخير'); }; };
  if (!staff) return;
  $('#af').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); act({ action: 'approve', video: !!f.get('video'), q: !!f.get('q') }, 'اتعتمد'); };
  $('#rf').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); act({ action: 'rate', r_video: f.get('r_video'), r_q: f.get('r_q'), r_instr: f.get('r_instr'), r_comm: f.get('r_comm') }, 'التقييم اتحفظ'); };
  if ($('#up')) $('#up').onclick = () => act({ action: 'uploaded' }, 'اتسجل الرفع');
  if ($('#exq')) $('#exq').onclick = () => act({ action: 'exempt_q' }, 'اتعفت من ملف الأسئلة');
  if ($('#unexq')) $('#unexq').onclick = () => act({ action: 'unexempt_q' }, 'الإعفاء اتلغى');
  if ($('#fw')) $('#fw').onclick = () => act({ action: 'forward' }, 'الملفات اتبعتتلك على تليجرام');
  if ($('#cx')) $('#cx').onclick = () => { modal(`<b>مسح المحاضرة #${l.id}</b>`, `<p>${esc(l.name)}</p><p class="red">المحاضرة هتتمسح نهائي بكل بياناتها وتقييمها، ومش هتتحسب في أي حساب. متأكد؟</p><div class="row"><button class="btn r" id="cxy">أيوه، امسحها</button><button class="btn g" data-close>لا</button></div>`); $('#cxy').onclick = async () => { await api('PATCH', '/api/lectures/' + id, { action: 'cancel' }); dlg.close(); toast('اتمسحت'); render(); }; };
  if ($('#pr')) $('#pr').onclick = () => modal(`<b>تعديل سعر #${l.id}</b>`, `<form id="pf"><label>السعر الجديد<input type="number" step="0.01" min="0" name="price" value="${l.price}" required></label><p class="mut">التعديل بيتسجل باسمك والدكتور بيتبلّغ على البوت.</p><button class="btn">حفظ</button></form>`) || ($('#pf').onsubmit = async e => { e.preventDefault(); await api('PATCH', '/api/lectures/' + id, { action: 'price', price: new FormData(e.target).get('price') }); toast('السعر اتعدّل'); openLecture(id); render(); });
}

/* ----- tickets ----- */
const media = (src, mime, name) => { mime = mime || ''; if (/^audio|ogg|opus/.test(mime)) return `<div style="margin-top:10px"><audio controls preload="none" src="${esc(src)}" style="width:100%"></audio><a class="mut" href="${esc(src)}" target="_blank" rel="noopener">تحميل</a></div>`; if (mime.startsWith('image/')) return `<div style="margin-top:10px"><a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="" style="max-width:100%;border-radius:8px"></a></div>`; if (mime.startsWith('video/')) return `<div style="margin-top:10px"><video controls preload="none" src="${esc(src)}" style="width:100%;border-radius:8px"></video></div>`; return `<div style="margin-top:10px"><a class="btn g sm" href="${esc(src)}" target="_blank" rel="noopener">فتح ${esc(name || 'الملف')}</a></div>`; };
let TF = 'open';
const STG = { new: ['جديد · مستني يتبعت للدكتور', 'pd'], doctor: ['عند الدكتور', 'rv'], return: ['مستني يرجع لخدمة العملاء', 'warn'], deliver: ['مستني يتبعت للطالب', 'warn'], problem: ['مشكلة مفتوحة', 'bad'], closed: ['مقفولة', 'ok'] };
V.tickets = async () => {
  const [ts, bs] = await Promise.all([api('GET', '/api/tickets' + (TF === 'open' ? '?open=1' : '')), api('GET', '/api/batches')]); cache.batches = bs; cache.tickets = ts;
  const mineFirst = ME.role === 'cs' ? ['deliver'] : ME.role === 'coordinator' ? ['new', 'return', 'problem'] : [];
  ts.sort((a, b) => (mineFirst.includes(b.stage) - mineFirst.includes(a.stage)));
  const rcs = ME.role === 'cs' ? await rankCard() : '';
  $('#main').innerHTML = `${rcs}<div class="row sp"><h2>الأسئلة والمشاكل</h2>${['admin', 'cs', 'coordinator', 'supervisor'].includes(ME.role) ? '<button class="btn a" id="nt">+ تذكرة جديدة</button>' : ''}</div>
  <p class="note">مسؤول الدفعة معاه ${esc(ME.settings.coord_reply_minutes)} دقيقة يرجّع رد الدكتور، وخدمة العملاء معاها ${esc(ME.settings.cs_reply_minutes)} دقيقة توصّله للطالب.</p>
  <div class="tabs"><button data-tf="open" class="${TF === 'open' ? 'on' : ''}">المفتوحة</button><button data-tf="all" class="${TF === 'all' ? 'on' : ''}">الكل</button></div>
  <div class="panel" style="padding:6px 10px">${ts.length ? `<table class="stack"><thead><tr><th>#</th><th>النوع</th><th>الدفعة</th><th>النص</th><th>المرحلة</th><th>الوقت</th><th></th></tr></thead><tbody>${ts.map(t => `<tr><td><b>${t.id}</b></td><td>${t.kind === 'question' ? 'سؤال' : 'مشكلة'}</td><td dir="ltr">${esc(t.batch_code)}</td><td>${esc(t.body.slice(0, 90))}${t.has_att ? ' <span class="p pd">مرفق</span>' : ''}${t.reply_file_id ? ' <span class="p rv">رد صوتي/ملف</span>' : ''}${t.student ? `<div class="mut">${esc(t.student)}</div>` : ''}${t.priority >= 2 ? ` <span class="p bad">${PRI[t.priority][0]}</span>` : ''}${t.direct ? ' <span class="p rv">سؤال لدكتور</span>' : ''}${t.due_at && !t.closed_at ? `<div class="${t.due_late ? 'red' : 'mut'}">المهلة: ${fmt(t.due_at)}${t.due_late ? ' · عدّت' : ''}</div>` : ''}</td><td>${pill(...STG[t.stage])}${t.coord_late ? '<div class="mut red">المسؤول اتأخر</div>' : ''}${t.cs_late ? '<div class="mut red">خدمة العملاء اتأخرت</div>' : ''}</td><td>${fmt(t.created_at)}</td><td><button class="btn g sm" data-tk="${t.id}">فتح</button></td></tr>`).join('')}</tbody></table>` : empty('مفيش تذاكر')}</div>`;
  document.querySelectorAll('[data-tf]').forEach(b => (b.onclick = () => { TF = b.dataset.tf; V.tickets(); }));
  if ($('#nt')) $('#nt').onclick = newTicket;
};
function newTicket() {
  modal('<b>تذكرة جديدة</b>', `<form id="tf"><div class="two"><label>النوع<select name="kind">${opts([['question', 'سؤال طالب'], ['problem', 'مشكلة']], 'question')}</select></label><label>الدفعة<select name="batch_id" id="tb" required>${opts(cache.batches.map(b => [b.id, b.code + ' · ' + b.uni]), '', 'اختار الدفعة')}</select></label></div>
  <label>المحاضرة (للأسئلة)<select name="lecture_id" id="tl"><option value="">—</option></select></label><label id="tto" hidden>يروح لمين؟<select name="to">${opts([['doctor', 'دكتور المحاضرة على طول'], ['coord', 'مسؤول الدفعة (يرد بنفسه أو يبعته)']], 'doctor')}</select></label><label id="tgd" hidden>الدكتور (السؤال هيروحله على طول)<select name="doctor_id" id="tdoc"><option value="">اختار الدكتور</option></select></label><label>الطالب (اسم أو رقم)<input name="student"></label>
  <div class="two"><label>الأولوية<select name="priority">${opts(Object.entries(PRI).map(([k, v]) => [k, v[0]]).reverse(), '1')}</select></label><label>عايز الرد خلال<select name="due_hours" id="tdue">${opts([['', 'من غير مهلة'], ['1', 'ساعة'], ['3', '3 ساعات'], ['6', '6 ساعات'], ['12', '12 ساعة'], ['24', '24 ساعة'], ['48', '48 ساعة'], ['c', 'مهلة تانية…']], '')}</select></label></div><label id="tduec" hidden>المهلة بالساعات<input type="number" min="0.25" step="0.25" id="tduen"></label><label>النص (لو السؤال ريكورد بس سيبه فاضي)<textarea name="body"></textarea></label><label>ريكورد أو صورة أو ملف السؤال (اختياري)<input type="file" name="att" accept="audio/*,image/*,video/*,.pdf,.ogg,.opus,.m4a,.mp3"></label><button class="btn a">فتح التذكرة</button></form>`);
  $('#tb').onchange = async () => { const ls = await api('GET', '/api/lectures?limit=200&batch=' + $('#tb').value); $('#tl').innerHTML = '<option value="">—</option><option value="doc">👨‍⚕️ سؤال لدكتور (من غير محاضرة)</option>' + ls.map(l => `<option value="${l.id}">#${l.id} ${esc(l.name)} · ${esc(l.doctor)}</option>`).join(''); };
  $('#tl').onchange = async () => { const g = $('#tl').value === 'doc'; $('#tgd').hidden = !g; $('#tto').hidden = !$('#tl').value || g || $('#tf').kind.value !== 'question'; if (g && $('#tdoc').options.length < 2) { const ds = cache.doctors || (cache.doctors = await api('GET', '/api/doctors')); $('#tdoc').innerHTML += ds.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join(''); } };
  $('#tdue').onchange = () => { $('#tduec').hidden = $('#tdue').value !== 'c'; };
  $('#tf').onsubmit = async e => { e.preventDefault(); const fd = new FormData(e.target);
    if (fd.get('lecture_id') === 'doc') { if (!fd.get('doctor_id')) return toast('اختار الدكتور'); fd.set('lecture_id', ''); } else fd.delete('doctor_id');
    if (fd.get('due_hours') === 'c') fd.set('due_hours', $('#tduen').value || ''); if (!String(fd.get('body')).trim() && !(fd.get('att') && fd.get('att').size)) return toast('اكتب السؤال أو ارفع الريكورد'); const btn = e.target.querySelector('button'); btn.disabled = true; try { const r = await api('POST', '/api/tickets', fd); dlg.close(); toast('التذكرة اتفتحت #' + r.id); render(); } catch { btn.disabled = false; } };
}
async function openTicket(id) {
  let t = (cache.tickets || []).find(x => x.id === id);
  if (!t) { const ts = await api('GET', '/api/tickets'); t = ts.find(x => x.id === id); if (!t) return toast('مش موجودة'); }
  t = { ...t, parts: t.parts_count ? await api('GET', `/api/tickets/${id}/parts`) : [] };
  const coord = ['admin', 'coordinator', 'supervisor'].includes(ME.role), cs = ['admin', 'cs'].includes(ME.role), byS = x => (x && x.role !== 'coordinator' ? ` · بواسطة ${x.name}${x.role === 'supervisor' ? ' (المشرف)' : ''}` : '');
  const log = [[t.created_at, `اتفتحت بواسطة ${t.created_by_name}`], t.sent_doctor_at && [t.sent_doctor_at, `اتبعتت لـ ${t.doctor}${t.direct ? ' مباشرة من خدمة العملاء' : byS(t.by.sent)}`], t.reply_at && [t.reply_at, `الدكتور رد (بعد ${dur(t.reply_at - t.sent_doctor_at)})`], t.returned_at && [t.returned_at, `رجعت لخدمة العملاء (بعد ${dur(t.returned_at - t.reply_at)})${t.coord_late ? ` · متأخر على المسؤول${t.both_late ? ' والمشرف' : ''}` : ''}${byS(t.by.returned)}`], t.delivered_at && [t.delivered_at, `اتبعتت للطالب (بعد ${dur(t.delivered_at - t.returned_at)})${t.cs_late ? ' · متأخر' : ''}`], t.kind === 'problem' && t.closed_at && [t.closed_at, 'اتحلت واتقفلت' + byS(t.by.closed)], t.due_at && [t.due_at, `المهلة المطلوبة${t.due_late ? ' (عدّت)' : ''}`]].filter(Boolean);
  let act = '';
  if ((coord || cs) && !t.closed_at) act += `<div class="panel"><div class="two"><label>الأولوية<select id="tpri">${opts(Object.entries(PRI).map(([k, v]) => [k, v[0]]).reverse(), t.priority)}</select></label><label>المهلة${t.due_at ? ` (دلوقتي ${fmt(t.due_at)})` : ''}<select id="tdu2">${opts([['', '— زي ما هي —'], ['0', 'شيل المهلة'], ['1', 'ساعة من دلوقتي'], ['3', '3 ساعات'], ['6', '6 ساعات'], ['12', '12 ساعة'], ['24', '24 ساعة']], '')}</select></label></div></div>`;
  if (ME.role === 'supervisor' && !t.closed_at && ['new', 'return', 'problem'].includes(t.stage)) act += `<p class="amber">انت المشرف: لو المسؤول اتأخر تقدر تعمل الخطوة دي بنفسك. هتتسجل باسمك، والتأخير هيفضل على المسؤول.</p>`;
  if (t.stage === 'new' && coord) act += `<form id="tsr" class="panel"><h3>✍️ هرد أنا</h3><p class="mut">لو عارف الإجابة اكتبها هنا، وهتروح لخدمة العملاء على طول.</p><textarea name="reply" required></textarea><button class="btn a sm">إرسال الرد لخدمة العملاء</button></form>`;
  if (t.stage === 'new' && coord) { const ds = cache.doctors || (cache.doctors = await api('GET', '/api/doctors')); act += `<form id="ta" class="panel"><h3>ابعت السؤال للدكتور</h3><label>الدكتور<select name="doctor_id" required>${opts(ds.map(d => [d.id, d.name]), t.doctor_id, 'اختار')}</select></label><button class="btn a">إرسال عبر البوت</button></form>`; }
  if (t.stage === 'doctor' && coord) act += `<form id="tr" class="panel"><h3>الدكتور لسه مارد</h3><p class="mut">لو رد عليك برة البوت اكتب الرد هنا.</p><textarea name="reply" required></textarea><button class="btn sm">تسجيل الرد</button></form>`;
  if (t.stage === 'return' && coord) act += `<div class="panel"><h3>رجّع الرد لخدمة العملاء</h3><button class="btn a" id="tret">تم، الرد رجع لخدمة العملاء</button></div>`;
  if (t.stage === 'deliver' && cs) act += `<div class="panel"><h3>ابعت الرد للطالب</h3><button class="btn a" id="tdel">تم، الرد اتبعت للطالب</button></div>`;
  if (t.stage === 'problem' && coord && !t.sent_doctor_at) { const ds = cache.doctors || (cache.doctors = await api('GET', '/api/doctors')); act += `<form id="ta" class="panel"><h3>ابعت المشكلة لدكتور (لو محتاجة رده)</h3><label>الدكتور<select name="doctor_id" required>${opts(ds.map(d => [d.id, d.name]), t.doctor_id, 'اختار')}</select></label><button class="btn g sm">إرسال للدكتور</button></form>`; }
  if (t.stage === 'problem' && (coord || cs)) act += `<form id="tc" class="panel"><h3>قفل المشكلة</h3><label>اتحلت إزاي<textarea name="resolution" required></textarea></label><button class="btn a">قفل</button></form>`;
  if (ME.role === 'admin') act += `<div class="row" style="margin-top:12px"><button class="btn sm r" id="tdx">مسح التذكرة</button></div>`;
  modal(`<b>${t.kind === 'question' ? 'سؤال' : 'مشكلة'} #${t.id}</b> ${pill(...STG[t.stage])}`, `<p class="mut"><span dir="ltr">${esc(t.batch_code)}</span>${t.lecture ? ' · ' + esc(t.lecture) : ''}${t.student ? ' · الطالب: ' + esc(t.student) : ''}</p><div class="panel">${esc(t.body)}${t.has_att ? media(`/api/tickets/${t.id}/attachment`, t.att_mime, t.att_name) : ''}${partsHtml(t.parts)}</div>${(cs || coord) && !t.reply_at && !t.closed_at ? `<form id="tpart" class="panel"><b>➕ إضافة للسؤال</b> <span class="mut">(لو الطالب بعت حاجة زيادة)</span><textarea name="body" rows="2"></textarea><div class="row sp"><input type="file" name="file" style="max-width:60%"><button class="btn g sm">إضافة</button></div></form>` : ''}${t.reply ? `<div class="panel"><h3>رد الدكتور</h3>${esc(t.reply)}${t.has_reply_file ? media(`/api/tickets/${t.id}/reply-file`, t.reply_mime || { voice: 'audio/ogg', audio: 'audio/mpeg', photo: 'image/jpeg', video: 'video/mp4', video_note: 'video/mp4' }[t.reply_kind] || '', 'رد الدكتور') + '<div style="margin-top:8px"><button class="btn g sm" id="tfw">ابعتلي الرد على تليجرام</button> <span class="mut">لو الصوت مش بيشتغل عندك</span></div>' : ''}</div>` : ''}${t.resolution ? `<div class="panel"><h3>الحل</h3>${esc(t.resolution)}</div>` : ''}<h3>المراحل</h3><ul class="log">${log.map(([a, x]) => `<li><span class="mut">${fmt(a)}</span><br>${esc(x)}</li>`).join('')}</ul>${act}`);
  const go = async (b, m) => { await api('PATCH', '/api/tickets/' + id, b); dlg.close(); toast(m); render(); };
  if ($('#ta')) $('#ta').onsubmit = e => { e.preventDefault(); go({ action: 'send_doctor', doctor_id: new FormData(e.target).get('doctor_id') }, 'اتبعت للدكتور'); };
  if ($('#tr')) $('#tr').onsubmit = e => { e.preventDefault(); go({ action: 'set_reply', reply: new FormData(e.target).get('reply') }, 'الرد اتسجل'); };
  if ($('#tret')) $('#tret').onclick = () => go({ action: 'return' }, 'رجع لخدمة العملاء');
  if ($('#tdel')) $('#tdel').onclick = () => go({ action: 'deliver' }, 'التذكرة اتقفلت');
  if ($('#tpart')) $('#tpart').onsubmit = async e => { e.preventDefault(); const fd = new FormData(e.target); if (!(fd.get('file') && fd.get('file').size)) fd.delete('file'); await api('POST', `/api/tickets/${id}/parts`, fd); dlg.close(); toast('اتضافت للسؤال ✓'); render(); };
  if ($('#tsr')) $('#tsr').onsubmit = e => { e.preventDefault(); go({ action: 'self_reply', reply: new FormData(e.target).get('reply') }, 'ردك راح لخدمة العملاء'); };
  if ($('#tpri')) $('#tpri').onchange = async () => { await api('PATCH', '/api/tickets/' + id, { action: 'priority', priority: $('#tpri').value }); toast('الأولوية اتغيرت'); render(); };
  if ($('#tdu2')) $('#tdu2').onchange = async () => { if ($('#tdu2').value === '') return; await api('PATCH', '/api/tickets/' + id, { action: 'due', due_hours: $('#tdu2').value }); toast('المهلة اتغيرت'); dlg.close(); render(); };
  if ($('#tfw')) $('#tfw').onclick = async () => { await api('PATCH', '/api/tickets/' + id, { action: 'forward' }); toast('الرد اتبعتلك على تليجرام'); };
  if ($('#tdx')) $('#tdx').onclick = () => { if ($('#tdx').dataset.sure) return go({ action: 'delete' }, 'اتمسحت'); $('#tdx').dataset.sure = 1; $('#tdx').textContent = 'متأكد؟ دوس تاني للمسح'; };
  if ($('#tc')) $('#tc').onsubmit = e => { e.preventDefault(); go({ action: 'close', resolution: new FormData(e.target).get('resolution') }, 'المشكلة اتقفلت'); };
}

/* ----- doctor: questions sent to me ----- */
V.myq = async () => {
  const qs = await api('GET', '/api/my-questions'), open = qs.filter(q => !q.reply_at);
  const card = q => `<div class="panel"${q.urgent && !q.reply_at ? ' style="border-color:var(--red)"' : ''}><div class="row sp"><b>${q.kind === 'problem' ? 'مشكلة' : 'سؤال'} #${q.id}</b><span class="mut">${fmt(q.sent_doctor_at)}</span></div>
    ${q.urgent && !q.reply_at ? '<p class="red"><b>🔴 مستعجل – لازم يترد عليه على طول</b></p>' : ''}${q.lecture ? `<p class="mut">على محاضرة: ${esc(q.lecture)}</p>` : ''}${q.due_at && !q.reply_at ? `<p class="${Date.now() > q.due_at ? 'red' : 'mut'}">مطلوب الرد قبل: ${fmt(q.due_at)}</p>` : ''}
    <div style="white-space:pre-wrap">${esc(q.body)}</div>${q.has_att ? media(`/api/tickets/${q.id}/attachment`, q.att_mime) : ''}${partsHtml(q.parts)}
    ${q.reply_at ? `<div class="panel" style="margin-top:10px"><b>ردك</b> <span class="mut">${fmt(q.reply_at)}</span><div style="white-space:pre-wrap">${esc(q.reply)}</div>${q.has_reply_file ? media(`/api/tickets/${q.id}/reply-file`, q.reply_kind === 'voice' ? 'audio/ogg' : '') : ''}</div>`
    : `<form data-rq="${q.id}" style="margin-top:10px"><textarea name="reply" placeholder="اكتب ردك هنا"></textarea><div class="row"><button type="button" class="btn g sm" data-rec="${q.id}">🎙 سجّل ريكورد</button><span class="mut" id="rs${q.id}"></span></div><label>أو ارفع ملف (ريكورد، صورة، PDF)<input type="file" name="file" accept="audio/*,image/*,video/*,.pdf"></label><button class="btn a">إرسال الرد</button></form>`}</div>`;
  $('#main').innerHTML = `<h2>الأسئلة${open.length ? ` · ${open.length} مستنية ردك` : ''}</h2><p class="note">أسئلة الطلبة اللي اتبعتتلك. ترد من هنا أو من البوت (Reply على رسالة السؤال)، والرد بيروح لمسؤول الدفعة.</p>${qs.length ? qs.map(card).join('') : empty('مفيش أسئلة لسه')}`;
  const recs = {};
  document.querySelectorAll('[data-rec]').forEach(b => (b.onclick = async () => {
    const id = b.dataset.rec, st = $('#rs' + id);
    if (recs[id] && recs[id].state === 'recording') { recs[id].stop(); b.textContent = '🎙 سجّل تاني'; return; }
    try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); const mr = new MediaRecorder(stream), ch = []; recs[id] = mr;
      mr.ondataavailable = e => ch.push(e.data); mr.onstop = () => { stream.getTracks().forEach(t => t.stop()); recs[id].blob = new Blob(ch, { type: mr.mimeType || 'audio/webm' }); st.textContent = 'الريكورد جاهز ✓'; };
      mr.start(); b.textContent = '⏹ وقّف التسجيل'; st.textContent = 'بيسجّل…'; } catch { toast('المتصفح مش سامح بالمايك، ارفع ملف بدل كده'); }
  }));
  document.querySelectorAll('[data-rq]').forEach(f => (f.onsubmit = async e => {
    e.preventDefault(); const id = f.dataset.rq, r = recs[id], txt = f.querySelector('textarea').value.trim(), up = f.querySelector('input[type=file]').files[0];
    const file = r && r.blob ? new File([r.blob], 'reply.' + ((r.blob.type.split('/')[1] || 'webm').split(';')[0]), { type: r.blob.type }) : up || null;
    if (!txt && !file) return toast('اكتب ردك أو سجّل ريكورد');
    const body = new FormData(); body.set('reply', txt); if (file) body.set('file', file, file.name);
    const btn = f.querySelector('.btn.a'); btn.disabled = true;
    try { await api('POST', `/api/my-questions/${id}/reply`, body); toast('الرد اتبعت ✓'); V.myq(); } catch { btn.disabled = false; }
  }));
};

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
async function autoReport(day) {
  const r = await api('GET', '/api/daily-report?day=' + day), d = r.delivered, miss = r.team.filter(x => x.missing.length);
  const tbl = (head, rows) => `<table class="stack"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  const html = `<section class="panel" id="autorep"><div class="row sp"><h3 style="margin:0">التقرير التلقائي · ${esc(r.day)}</h3><span class="row"><button class="btn g sm" id="arcp">نسخ كنص</button><button class="btn g sm" id="artg">ابعتهولي على تليجرام</button></span></div>
  <p class="mut">بيتعمل لوحده من الداتا. ${day === ME.today ? 'الأرقام لحد دلوقتي.' : 'الأرقام زي ما كانت آخر اليوم ده.'}</p>
  <div class="kpis">${kpi(d.n, 'محاضرة اتشرحت')}${kpi(money(d.total), 'إجمالي سعرهم')}${kpi(r.late.length, 'محاضرة متأخرة', r.late.length)}${kpi(r.problems.length, 'مشكلة مفتوحة', r.problems.length)}${kpi(r.lateQ.length, 'سؤال متأخر', r.lateQ.length)}${kpi(miss.length, 'ناقصهم تاسكات', miss.length)}</div>
  ${Object.keys(d.byType).length ? `<p>${Object.entries(d.byType).map(([t, x]) => `${TY()[t]}: ${x.n} = ${money(x.sum)}`).join(' · ')}</p>` : ''}
  <h3>المحاضرات المتأخرة (${r.late.length})</h3>${r.late.length ? tbl(['المحاضرة', 'الدكتور', 'متأخرة من', 'ناقص', 'المسؤول', 'المشرف'], r.late.map(l => `<tr class="click" data-lec="${l.id}"><td><b>#${l.id} ${esc(l.name)}</b><div class="mut"><span dir="ltr">${esc(l.batch_code)}</span> · الديدلاين ${fmt(l.since)}${l.priority >= 2 ? ' · ' + PRI[l.priority][0] : ''}</div></td><td>${esc(l.doctor)}</td><td class="red">${dur(l.late_ms)}</td><td>${esc(l.missing.join(' و'))}</td><td>${esc(l.coordinator)}</td><td>${esc(l.supervisor)}</td></tr>`)) : '<p class="ok">مفيش محاضرات متأخرة ✓</p>'}
  <h3>المشاكل المفتوحة (${r.problems.length})</h3>${r.problems.length ? tbl(['#', 'الدفعة', 'المشكلة', 'مفتوحة من', 'المسؤول'], r.problems.map(x => `<tr class="click" data-tk="${x.id}"><td>${x.id}</td><td dir="ltr">${esc(x.batch_code)}</td><td>${esc(x.body)}${x.student ? `<div class="mut">${esc(x.student)}</div>` : ''}</td><td>${dur(x.age_ms)}</td><td>${esc(x.coordinator)}</td></tr>`)) : '<p class="ok">مفيش ✓</p>'}
  <h3>الأسئلة المتأخرة (${r.lateQ.length})</h3>${r.lateQ.length ? tbl(['#', 'الدفعة', 'فين واقف', 'متأخر', 'على مين'], r.lateQ.map(x => `<tr class="click" data-tk="${x.id}"><td>${x.id}</td><td dir="ltr">${esc(x.batch_code)}</td><td>${esc(x.stage)}${x.student ? `<div class="mut">${esc(x.student)}</div>` : ''}</td><td class="red">${dur(x.late_ms)}</td><td>${esc(x.owner)}</td></tr>`)) : '<p class="ok">مفيش ✓</p>'}
  ${r.waitingDoctor.length ? `<details><summary>أسئلة مستنية رد الدكتور (${r.waitingDoctor.length})</summary>${tbl(['#', 'الدفعة', 'الدكتور', 'مستني من'], r.waitingDoctor.map(x => `<tr class="click" data-tk="${x.id}"><td>${x.id}</td><td dir="ltr">${esc(x.batch_code)}</td><td>${esc(x.doctor || '—')}</td><td>${dur(x.age_ms)}</td></tr>`))}</details>` : ''}
  <h3>التاسكات الناقصة النهارده</h3>${r.team.length ? tbl(['الشخص', 'خلّص', 'الناقص'], r.team.map(x => `<tr><td><b>${esc(x.name)}</b><div class="mut">${ROLE[x.role] || ''}</div></td><td class="n${x.missing.length ? ' red' : ''}">${x.done}/${x.total}</td><td>${x.missing.length ? x.missing.map(m => `<div>✗ ${esc(m)}</div>`).join('') : '<span class="ok">كله تمام ✓</span>'}</td></tr>`)) : empty('مفيش تيم')}
  ${d.list.length ? `<details style="margin-top:10px"><summary>المحاضرات اللي اتشرحت (${d.n}) · ${money(d.total)}</summary>${tbl(['المحاضرة', 'الدكتور', 'النوع', 'السعر'], d.list.map(l => `<tr class="click" data-lec="${l.id}"><td>#${l.id} ${esc(l.name)}<div class="mut" dir="ltr">${esc(l.batch_code || '')}</div></td><td>${esc(l.doctor)}${l.late ? ' <span class="p bad">متأخر</span>' : ''}</td><td>${TY()[l.type]}</td><td class="n">${money(l.price)}</td></tr>`))}</details>` : ''}
  </section>`;
  return { html, text: r.text };
}
function bindAutoReport(rep, day) {
  $('#arcp').onclick = async () => { try { await navigator.clipboard.writeText(rep.text); toast('اتنسخ ✓'); } catch { toast('النسخ مش متاح'); } };
  $('#artg').onclick = async () => { await api('POST', '/api/daily-report/send', { day }); toast('اتبعت على تليجرام ✓'); };
}
V.reports = async () => {
  const day = cache.rday || ME.today; const [r, rep] = await Promise.all([api('GET', '/api/reports?day=' + day), autoReport(day)]);
  const dayPick = `<input type="date" id="rday" value="${esc(day)}" style="width:auto">`;
  if (ME.role === 'supervisor') {
    const s = r.draft, draft = r.mine?.body || `ملخص ${day}:\n- اتبعتت ${s.sent} محاضرة، واتسلم ${s.videos} فيديو و${s.qfiles} ملف أسئلة، واترفعت ${s.uploaded}.\n- متأخر دلوقتي ${s.lateNow}، ومشاكل مفتوحة ${s.problemsOpen}.\n- `;
    $('#main').innerHTML = `<div class="row sp"><h2>التقرير اليومي</h2>${dayPick}</div>${rep.html}
    <section class="panel"><h3>تقارير التيم</h3>${r.team.map(c => `<details class="panel" style="margin-bottom:8px"><summary><b>${esc(c.name)}</b> · ${c.report.items.filter(i => i.done && !i.weekly).length}/${c.report.items.filter(i => !i.weekly).length} مهام</summary>${c.report.items.map(i => `<p>${i.done ? '✓' : '✗'} ${esc(i.label)}${i.note ? `<br><span class="mut">${esc(i.note)}</span>` : ''}</p>`).join('')}</details>`).join('') || empty('مفيش مسؤولين')}</section>
    <form id="rf" class="panel"><h3>ملخص يومك ${r.mine ? '<span class="ok">(اترفع ✓)</span>' : ''}</h3><textarea name="body" rows="8" required>${esc(draft)}</textarea><button class="btn a">رفع التقرير للأدمن</button></form>`;
    $('#rf').onsubmit = async e => { e.preventDefault(); await api('PUT', '/api/reports', { body: new FormData(e.target).get('body') }); toast('التقرير اترفع'); V.reports(); };
  } else {
    $('#main').innerHTML = `<div class="row sp"><h2>تقارير ${esc(day)}</h2>${dayPick}</div>${rep.html}
    <section class="panel"><h3>تقارير المشرفين</h3>${r.supervisors.map(s => `<div class="panel"><b>${esc(s.name)}</b> ${s.body ? `<span class="mut">${fmt(s.created_at)}</span><p style="white-space:pre-wrap">${esc(s.body)}</p>` : '<p class="red">لسه مارفعش تقريره</p>'}</div>`).join('')}</section>
    <section class="panel"><div class="row sp"><h3>برومبت التحليل اليومي</h3><button class="btn a sm" id="cp">نسخ البرومبت</button></div><p class="mut">انسخه وحطه في أي ذكاء اصطناعي يحللك اليوم ويقولك تعمل إيه بكرة.</p><pre class="prompt" id="pt">بيحمّل…</pre></section>`;
    api('GET', '/api/prompt?day=' + day).then(p => { $('#pt').textContent = p.text; });
    $('#cp').onclick = async () => { try { await navigator.clipboard.writeText($('#pt').textContent); toast('اتنسخ'); } catch { toast('حدد النص وانسخه بإيدك'); } };
  }
  bindAutoReport(rep, day);
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
  ${['admin', 'supervisor'].includes(ME.role) ? '<div class="panel"><h3>ترتيب المحاضرات المفتوحة</h3><p class="mut">رتّب المحاضرات بالأهمية اللي إنت شايفها. الدكتور بيشوفها بالترتيب ده في البوت واللوحة، من غير ما يشوف الأولوية.</p><div id="dq">بيحمّل…</div></div>' : ''}
  <h3>آخر المحاضرات</h3>${lecTable(d.lectures)}
  ${d.notes ? `<div class="panel"><h3>ملاحظات الفريق</h3><p class="mut">الدكتور مش بيشوف الملاحظات دي. بيشوفها الأدمن والمشرفين ومسؤولين الدفعات.</p><div id="nl">${d.notes.length ? notesHtml(d.notes) : '<p class="mut">مفيش ملاحظات لسه.</p>'}</div><form id="nf2" style="margin-top:8px"><textarea name="body" rows="2" required placeholder="مثلاً: شرحه سريع في الجزء العملي، أو: اتأخر بسبب سفر واتفقنا معاه"></textarea><button class="btn sm">إضافة ملاحظة</button></form></div>` : ''}
  <h3>العقوبات</h3>${d.penalties.length ? d.penalties.map(p => `<p>${pill(PST[p.status][0], PST[p.status][1])} ${esc(p.kind)}${p.amount ? ' · ' + money(p.amount) : ''} · ${esc(p.reason)} <span class="mut">${fmt(p.created_at)}</span></p>`).join('') : '<p class="mut">مفيش</p>'}`);
  if ($('#cf')) $('#cf').onsubmit = async e => { e.preventDefault(); await api('PATCH', '/api/doctors/' + id, Object.fromEntries(new FormData(e.target))); toast('اتحفظ'); openDoctor(id); };
  if ($('#nf2')) { $('#nf2').onsubmit = async e => { e.preventDefault(); const ns = await api('POST', `/api/doctors/${id}/notes`, Object.fromEntries(new FormData(e.target))); e.target.reset(); $('#nl').innerHTML = notesHtml(ns); bindNoteDel(() => openDoctor(id)); toast('اتضافت ✓'); }; bindNoteDel(() => openDoctor(id)); }
  if ($('#dq')) {
    let q = (await api('GET', `/api/lectures?doctor=${id}&sort=queue&limit=300`)).filter(l => !(l.video_at && l.q_at));
    const draw = () => { $('#dq').innerHTML = q.length ? `<table class="stack"><tbody>${q.map((l, i) => `<tr><td><b>${i + 1}</b></td><td>#${l.id} ${esc(l.name)}<div class="mut"><span dir="ltr">${esc(l.batch_code || '')}</span> · ${fmt(l.sent_at)}${l.excused ? ' · مستثناة' : ''}</div></td><td>${pill(...PRI[l.priority ?? 1])} ${pill(...LS[l.state])}</td><td class="n"><button class="btn g sm" data-up="${i}" ${i ? '' : 'disabled'}>▲</button> <button class="btn g sm" data-dn="${i}" ${i < q.length - 1 ? '' : 'disabled'}>▼</button></td></tr>`).join('')}</tbody></table><button class="btn a sm" id="qsave" style="margin-top:8px">حفظ الترتيب</button>` : empty('مفيش محاضرات مفتوحة');
      document.querySelectorAll('[data-up]').forEach(b => (b.onclick = () => { const i = +b.dataset.up; [q[i - 1], q[i]] = [q[i], q[i - 1]]; draw(); }));
      document.querySelectorAll('[data-dn]').forEach(b => (b.onclick = () => { const i = +b.dataset.dn; [q[i + 1], q[i]] = [q[i], q[i + 1]]; draw(); }));
      if ($('#qsave')) $('#qsave').onclick = async () => { await api('POST', `/api/doctors/${id}/queue`, { order: q.map(l => l.id) }); toast('الترتيب اتحفظ'); };
    };
    draw();
  }
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
  <div class="panel" style="padding:6px 10px">${ps.length ? `<table class="stack"><thead><tr><th>الشخص</th><th>السبب</th><th>القرار</th><th>الحالة</th><th>الاعتراض</th><th></th></tr></thead><tbody>${ps.map(p => `<tr><td><b>${esc(p.target)}</b><div class="mut">${ROLE[p.target_role] || ''}</div></td><td>${esc(p.reason)}<div class="mut">${fmt(p.created_at)}${p.proposer ? ' · ' + esc(p.proposer) : ''}</div></td><td>${esc(p.kind)}${p.amount ? `<div class="mut">${money(p.amount)}</div>` : ''}</td><td>${pill(...PST[p.status])}</td><td>${p.objection ? esc(p.objection) + (p.reply ? `<div class="mut">الرد: ${esc(p.reply)}</div>` : '') : '—'}</td><td>${admin && p.status === 'proposed' ? `<button class="btn sm a" data-pa="${p.id}">اعتماد</button> <button class="btn sm g" data-pr="${p.id}">رفض</button>` : ''}${admin && p.objection && !p.reply ? `<button class="btn sm g" data-prep="${p.id}">رد</button>` : ''}${p.user_id === ME.id && p.status === 'approved' && !p.objection ? `<button class="btn sm g" data-po="${p.id}">اعتراض</button>` : ''}${admin && !p.settlement_id ? ` <button class="btn sm g" data-pdel="${p.id}">مسح</button>` : ''}</td></tr>`).join('')}</tbody></table>` : empty('مفيش قرارات')}</div>`;
  if ($('#nf')) $('#nf').onsubmit = async e => { e.preventDefault(); await api('POST', '/api/penalties', Object.fromEntries(new FormData(e.target))); toast('اتسجل'); V.penalties(); };
  const P = (id, b, m) => api('PATCH', '/api/penalties/' + id, b).then(() => { dlg.close(); toast(m); V.penalties(); });
  document.querySelectorAll('[data-pdel]').forEach(b => (b.onclick = async () => { if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = 'متأكد؟'; return; } await api('DELETE', '/api/penalties/' + b.dataset.pdel); toast('اتمسح'); V.penalties(); }));
  document.querySelectorAll('[data-pa]').forEach(b => (b.onclick = () => P(b.dataset.pa, { action: 'approve' }, 'اتعتمد واتبلّغ')));
  document.querySelectorAll('[data-pr]').forEach(b => (b.onclick = () => P(b.dataset.pr, { action: 'reject' }, 'اترفض')));
  document.querySelectorAll('[data-po]').forEach(b => (b.onclick = () => { modal('<b>اعتراض</b>', '<form id="of"><textarea name="t" required placeholder="اكتب سبب الاعتراض"></textarea><button class="btn">إرسال</button></form>'); $('#of').onsubmit = e => { e.preventDefault(); P(b.dataset.po, { action: 'object', text: new FormData(e.target).get('t') }, 'الاعتراض وصل'); }; }));
  document.querySelectorAll('[data-prep]').forEach(b => (b.onclick = () => { modal('<b>الرد على الاعتراض</b>', '<form id="of"><textarea name="t" required></textarea><label class="chk"><input type="checkbox" name="c"> إلغاء القرار</label><button class="btn">إرسال</button></form>'); $('#of').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); P(b.dataset.prep, { action: 'reply', text: f.get('t'), cancel: !!f.get('c') }, 'الرد اتبعت'); }; }));
};

/* ----- finance ----- */
V.finance = async () => {
  const cur = ME.today.slice(0, 7), month = cache.fmonth || cur, r = await api('GET', '/api/finance?month=' + month), rows = r.rows;
  const picker = `<label class="row" style="gap:6px;margin:0">الشهر <input type="month" id="fmon" value="${esc(month)}" max="${esc(cur)}" style="width:auto" dir="ltr"></label>`;
  const groups = [['doctor', 'الدكاترة'], ['coordinator', 'مسؤولين الدفعات'], ['supervisor', 'المشرفين'], ['cs', 'خدمة العملاء']];
  const tot = rows.reduce((s, x) => s + x.net, 0);
  if (!r.history) {
    $('#main').innerHTML = `<div class="row sp"><h2>الحسابات · المستحق دلوقتي ${money(tot)}</h2>${picker}</div><p class="note">ده الشهر الحالي. كل مجموعة مرتبة من أعلى مستحقات لأقل. الدكتور بيتحاسب على المحاضرات اللي سلّمها بس، واللي ماسلّمهاش بتترحّل للفترة اللي بعدها. اختار شهر قديم من فوق عشان تشوف حساباته.</p>
    ${groups.map(([role, title]) => { const rs = rows.filter(x => x.role === role); if (!rs.length) return ''; const sub = rs.reduce((a, x) => a + x.net, 0);
      return `<section class="panel" style="padding:10px 12px"><div class="row sp"><h3 style="margin:0">${title}</h3><b>${money(sub)}</b></div><table class="stack"><thead><tr><th class="n">#</th><th>الاسم</th><th class="n">الأساسي</th><th class="n">بونص</th><th class="n">خصومات</th><th class="n">الصافي</th>${role === 'doctor' ? '<th class="n">محاضرات</th>' : ''}<th>التحويل</th><th></th></tr></thead><tbody>${rs.map((x, i) => `<tr class="click" data-fin="${x.id}"><td class="n">${i + 1}</td><td><b>${esc(x.name)}</b></td><td class="n">${money(x.gross)}</td><td class="n">${money(x.bonus)}</td><td class="n${x.deductions ? ' red' : ''}">${money(x.deductions)}</td><td class="n"><b>${money(x.net)}</b></td>${role === 'doctor' ? `<td class="n">${x.lectures}${x.pending ? ` <span class="mut">(+${x.pending} مفتوحة)</span>` : ''}</td>` : ''}<td>${x.payout ? '<span class="ok">متسجلة ✓</span>' : '<span class="mut">مش متسجلة</span>'}</td><td><button class="btn g sm">فتح</button></td></tr>`).join('')}</tbody></table></section>`; }).join('')}`;
  } else {
    const paid = rows.filter(x => !x.unpaid).length;
    $('#main').innerHTML = `<div class="row sp"><h2>حسابات ${esc(month)} · ${money(tot)}</h2>${picker}</div><p class="note">ده هيستوري الشهر: اللي اتقفل حسابه فيه، واتدفع ولا لأ، وأكد الاستلام ولا لأ. اتدفع ${paid} من ${rows.length}.</p>
    ${rows.length ? groups.map(([role, title]) => { const rs = rows.filter(x => x.role === role); if (!rs.length) return ''; const sub = rs.reduce((a, x) => a + x.net, 0);
      return `<section class="panel" style="padding:10px 12px"><div class="row sp"><h3 style="margin:0">${title}</h3><b>${money(sub)}</b></div><table class="stack"><thead><tr><th class="n">#</th><th>الاسم</th><th class="n">الإجمالي</th><th class="n">بونص</th><th class="n">خصومات</th><th class="n">الصافي</th>${role === 'doctor' ? '<th class="n">محاضرات</th>' : ''}<th>الدفع</th><th>الاستلام</th><th></th></tr></thead><tbody>${rs.map((x, i) => `<tr class="click" data-fin="${x.id}"><td class="n">${i + 1}</td><td><b>${esc(x.name)}</b>${x.n > 1 ? `<div class="mut">${x.n} تقفيلات</div>` : ''}</td><td class="n">${money(x.gross)}</td><td class="n">${money(x.bonus)}</td><td class="n${x.deductions ? ' red' : ''}">${money(x.deductions)}</td><td class="n"><b>${money(x.net)}</b></td>${role === 'doctor' ? `<td class="n">${x.lectures}</td>` : ''}<td>${x.unpaid ? '<span class="red">لسه</span>' : `<span class="ok">اتدفع ✓</span><div class="mut">${fmt(x.paid_at)}</div>`}</td><td>${x.confirmed_at ? `<span class="ok">استلم ✓</span><div class="mut">${fmt(x.confirmed_at)}</div>` : x.problem ? '<span class="red">فيه مشكلة</span>' : x.sent ? '<span class="mut">مستني تأكيده</span>' : '<span class="mut">—</span>'}</td><td><a class="btn g sm" style="display:inline-flex;align-items:center;text-decoration:none" href="/api/settlements/${x.last_sid}/pdf" target="_blank" rel="noopener" data-stop>كشف PDF</a></td></tr>`).join('')}</tbody></table></section>`; }).join('') : empty('مفيش حسابات اتقفلت في الشهر ده')}
    ${r.open.length ? `<section class="panel"><h3>ماتقفلش حسابهم في ${esc(month)} (${r.open.length})</h3><p>${r.open.map(x => `<button class="btn g sm" data-finu="${x.id}" style="margin:2px">${esc(x.name)} · ${ROLE[x.role]}</button>`).join(' ')}</p></section>` : ''}`;
  }
  $('#fmon').onchange = () => { const v = $('#fmon').value; cache.fmonth = v && v <= cur ? v : cur; V.finance(); };
  document.querySelectorAll('[data-fin]').forEach(x => (x.onclick = e => { if (e.target.closest('[data-stop]')) return; openFinance(Number(x.dataset.fin)); }));
};
const PAYOUT = { vodafone: 'فودافون كاش', instapay: 'إنستاباي', bank: 'حساب بنكي' };
const cp = v => v ? `<span class="row" style="gap:6px;display:inline-flex"><b dir="ltr">${esc(v)}</b><button type="button" class="btn g sm" data-copy="${esc(v)}" style="min-height:28px;padding:0 8px">نسخ</button></span>` : '—';
function payoutHtml(list, mine) {
  if (!list.length) return `<p class="mut">${mine ? 'لسه ماضفتش طريقة تحويل.' : 'مفيش طريقة تحويل متسجلة. اطلب منه يضيفها من صفحة حسابي.'}</p>`;
  return list.map(p => { const all = p.kind === 'bank' ? `${p.name}\n${p.bank}\nIBAN: ${p.iban || ''}\nرقم الحساب: ${p.account || ''}` : `${PAYOUT[p.kind]}\n${p.number}\n${p.name}`;
    return `<div class="panel" style="margin-bottom:8px"><div class="row sp"><b>${PAYOUT[p.kind]}</b><span>${mine ? `<button class="btn g sm" data-pdel="${p.id}">مسح</button>` : `<button type="button" class="btn g sm" data-copy="${esc(all)}">نسخ الكل</button>`}</span></div>
    ${p.kind === 'bank' ? `<p>الاسم: ${cp(p.name)}</p><p>البنك: ${cp(p.bank)}</p><p>الأيبان: ${cp(p.iban)}</p><p>رقم الحساب: ${cp(p.account)}</p>` : `<p>الرقم: ${cp(p.number)}</p><p>الاسم: ${cp(p.name)}</p>`}</div>`; }).join('');
}
document.addEventListener('click', async e => { const b = e.target.closest('[data-copy]'); if (!b) return; e.stopPropagation(); try { await navigator.clipboard.writeText(b.dataset.copy.replace(/\\n/g, '\n')); toast('اتنسخ ✓'); } catch { toast('النسخ مش متاح، حدد النص وانسخه'); } }, true);
const waNum = n => { n = String(n || '').replace(/[^\d]/g, ''); if (/^0\d{10}$/.test(n)) n = '20' + n.slice(1); return n; };
function contactBtns(u) {
  const b = [];
  if (u.whatsapp) b.push(`<a class="btn g sm" style="display:inline-flex;align-items:center;text-decoration:none" href="https://wa.me/${waNum(u.whatsapp)}" target="_blank" rel="noopener">واتساب ${esc(u.whatsapp)}</a>`);
  if (u.tg_username) b.push(`<a class="btn g sm" style="display:inline-flex;align-items:center;text-decoration:none" href="https://t.me/${encodeURIComponent(u.tg_username)}" target="_blank" rel="noopener">تليجرام @${esc(u.tg_username)}</a>`);
  return b.length ? `<div class="row">${b.join('')}</div>` : '<p class="mut">مفيش بيانات تواصل متسجلة.</p>';
}
function bindNoteDel(after) { document.querySelectorAll('[data-ndel]').forEach(b => (b.onclick = async () => { if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = 'متأكد؟'; return; } await api('DELETE', '/api/notes/' + b.dataset.ndel); toast('اتمسحت'); after(); })); }
const partsHtml = ps => (ps && ps.length ? ps.map(p => `<div style="border-top:1px dashed var(--line);margin-top:8px;padding-top:8px"><span class="mut">تكملة · ${fmt(p.created_at)}</span>${p.body ? `<div style="white-space:pre-wrap">${esc(p.body)}</div>` : ''}${p.has_file ? media(`/api/ticket-parts/${p.id}/file`, p.mime || { voice: 'audio/ogg', audio: 'audio/mpeg', photo: 'image/jpeg', video: 'video/mp4', video_note: 'video/mp4' }[p.file_kind] || '', p.name) : ''}</div>`).join('') : '');
const trStatus = t => (!t.needs_confirm ? '' : t.confirmed_at ? `<span class="p ok">استلم ✓ ${fmt(t.confirmed_at)}</span>` : t.problem ? '<span class="p bad">فيه مشكلة</span>' : '<span class="p pd">مستني تأكيده</span>');
const notesHtml = ns => ns.map(n => `<div style="border-bottom:1px solid var(--line);padding:6px 0"><span class="mut">${fmt(n.created_at)} · ${esc(n.author || '—')} (${ROLE[n.author_role] || ''})</span>${n.mine ? ` <button class="btn g sm" data-ndel="${n.id}" style="min-height:26px;padding:0 8px">مسح</button>` : ''}<div style="white-space:pre-wrap">${esc(n.body)}</div></div>`).join('');
function finBody(f, admin) {
  return `<div class="kpis" style="margin-top:0">${kpi(money(f.gross), f.user.role === 'doctor' ? 'المحاضرات' : 'الأساسي')}${kpi(money(f.bonus), 'بونص')}${kpi(money(f.deductions), 'خصومات', f.deductions)}${kpi(money(f.net), 'الصافي')}</div>
  ${f.user.role === 'doctor' ? `<p>${Object.entries(f.byType).map(([t, x]) => `${TY()[t]}: ${x.n} محاضرة = ${money(x.sum)}`).join(' · ') || 'مفيش محاضرات مسلّمة لسه'}${f.pendingLecs ? ` <span class="mut">· ${f.pendingLecs} محاضرة لسه ماتسلمتش وهتتحسب لما تتسلم</span>` : ''}</p>` : `<p>المرتب: ${money(f.salary)}</p>`}
  ${f.extra.length ? `<p>مستحقات إضافية: ${f.extra.map(x => `${money(x.amount)} (${esc(x.note || '')})${admin ? ` <button class="btn sm g" data-del="extra/${x.id}">مسح</button>` : ''}`).join('، ')}</p>` : ''}${f.bons.length ? `<p>بونص: ${f.bons.map(x => `${money(x.amount)} (${esc(x.note || '')})${admin ? ` <button class="btn sm g" data-del="bonuses/${x.id}">مسح</button>` : ''}`).join('، ')}</p>` : ''}${f.pens.length ? `<p class="red">خصومات: ${f.pens.map(x => `${money(x.amount)} (${esc(x.reason)})`).join('، ')}</p>` : ''}
  ${f.lecs.length ? `<details><summary>تفاصيل المحاضرات (${f.lecs.length})</summary><table class="stack"><tbody>${f.lecs.map(l => `<tr><td>#${l.id} ${esc(l.name)}</td><td>${TY()[l.type]}</td><td class="n">${money(l.price)}</td><td>${fmt(l.delivered_at)}</td></tr>`).join('')}</tbody></table></details>` : ''}
  ${admin ? `<p><button type="button" class="btn g sm" data-imp2="${f.user.id}">ادخل على حسابه</button></p><h3 style="margin-top:16px">طريقة التحويل</h3>${payoutHtml(f.payout || [], false)}
  <h3 style="margin-top:16px">التواصل</h3>${contactBtns(f.user)}
  <form id="trf" class="panel" style="margin-top:10px"><h3>إرسال إيصال التحويل أو ملاحظة</h3><p class="mut">هيوصله على البوت مباشرة${f.user.linked ? '' : ' <span class="red">(مش رابط البوت، فمش هيوصله)</span>'}.</p><label>إيصال التحويل (صورة أو PDF)<input type="file" name="receipt" accept="image/*,.pdf"></label><label>ملاحظة (أو المشكلة في التحويل)<textarea name="note" placeholder="مثلاً: اتحوّل 2400 على فودافون كاش، أو: الرقم ده مش شغال ابعتلي رقم تاني"></textarea></label>${f.settlements.length ? `<label>ابعت معاه كشف الحساب<select name="settlement_id">${opts(f.settlements.map(s => [s.id, `${s.period} · ${money(s.net)}`]), f.settlements[0].id, 'من غير كشف')}</select></label>` : ''}<label class="chk"><input type="checkbox" name="confirm" value="1" checked> يأكد إنه استلم (هيظهرله زرار "استلمت ✓" و"فيه مشكلة")</label><button class="btn a">إرسال</button></form>
  ${(f.transfers || []).length ? `<h3>رسايل الحسابات اللي اتبعتت</h3>${f.transfers.map(t => `<div style="border-bottom:1px solid var(--line);padding:6px 0"><span class="mut">${fmt(t.created_at)}</span> ${t.delivered ? '<span class="ok">وصلت ✓</span>' : '<span class="red">ماوصلتش</span>'} ${trStatus(t)}${t.note ? `<div>${esc(t.note)}</div>` : ''}${t.problem ? `<div class="red">المشكلة: ${esc(t.problem)}</div>` : ''}${t.has_file ? `<a href="/api/transfers/${t.id}/file" target="_blank" rel="noopener">${esc(t.file_name || 'الإيصال')}</a>` : ''}</div>`).join('')}` : ''}` : ''}
  <h3 style="margin-top:16px">التقفيلات السابقة</h3>${f.settlements.length ? `<table class="stack"><thead><tr><th>الفترة</th><th>النوع</th><th class="n">الصافي</th><th>الدفع</th></tr></thead><tbody>${f.settlements.map(s => `<tr><td>${esc(s.period)}</td><td>${s.kind === 'early' ? 'معجّل' : 'شهري'}</td><td class="n">${money(s.net)}</td><td>${s.paid_at ? `<span class="ok">اتدفع ${fmt(s.paid_at)}</span>` : admin ? `<button class="btn sm g" data-paid="${s.id}">تم الدفع</button>` : 'لسه'} <a class="btn sm g" style="display:inline-flex;align-items:center;text-decoration:none" href="/api/settlements/${s.id}/pdf" target="_blank" rel="noopener">كشف PDF</a>${admin ? ` <button class="btn sm g" data-stsend="${s.id}">ابعته على البوت</button> <button class="btn sm g" data-del="settlements/${s.id}">إلغاء التقفيل</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="mut">مفيش</p>'}
  ${f.notes && f.notes.length ? `<h3 style="margin-top:16px">ملاحظات الفريق على الدكتور</h3>${notesHtml(f.notes)}` : ''}`;
}
async function openFinance(id, period) {
  const per = period || ME.today.slice(0, 7), f = await api('GET', `/api/finance/${id}?period=${per}`);
  modal(`<b>${esc(f.user.name)}</b> <span class="mut">${ROLE[f.user.role]}</span>`, finBody(f, true) + `<div class="panel" style="margin-top:14px"><h3>إضافة</h3><form id="bf" class="row"><select name="what" style="width:auto">${opts([['bonuses', 'بونص'], ['extra', 'مستحق إضافي (زي مرتب متغير)']], 'bonuses')}</select><input name="amount" type="number" step="0.01" placeholder="المبلغ" required style="width:9em"><input name="note" placeholder="ملاحظة" style="flex:1"><button class="btn sm">إضافة</button></form></div>
  <div class="panel"><h3>التقفيل</h3><div class="row"><label class="row" style="gap:6px;margin:0">شهر <input type="month" id="per" value="${esc(per)}" max="${esc(ME.today.slice(0, 7))}" style="width:auto" dir="ltr"></label><button class="btn a" id="sm">تقفيل شهر ${esc(per)} (${money(f.net)})</button><button class="btn g" id="se">تقفيل معجّل</button></div><p class="mut">التقفيل الشهري بياخد المحاضرات اللي اتبعتت في الشهر ده واتسلمت، والمرتب والبونص والخصومات اللي فوق. اللي لسه ماتسلمش بيترحّل للشهر اللي بعده. لو غيّرت الشهر الأرقام فوق بتتحدث.</p></div>`);
  $('#per').onchange = () => openFinance(id, $('#per').value || undefined);
  document.querySelectorAll('[data-stsend]').forEach(b => (b.onclick = async () => { b.disabled = true; try { await api('POST', `/api/settlements/${b.dataset.stsend}/send`); toast('الكشف اتبعت على البوت ✓'); } catch { b.disabled = false; } }));
  bindNoteDel(() => openFinance(id, per));
  $('#trf').onsubmit = async e => { e.preventDefault(); const fd = new FormData(e.target); if (!fd.get('confirm')) fd.set('confirm', '0'); if (!String(fd.get('note')).trim() && !(fd.get('receipt') && fd.get('receipt').size)) return toast('اكتب ملاحظة أو ارفع الإيصال'); const btn = e.target.querySelector('button'); btn.disabled = true; try { const r = await api('POST', `/api/finance/${id}/message`, fd); toast(r.delivered ? 'اتبعت على البوت ✓' : 'اتسجلت بس ماوصلتش (مش رابط البوت)'); openFinance(id, per); } catch { btn.disabled = false; } };
  $('#bf').onsubmit = async e => { e.preventDefault(); const x = Object.fromEntries(new FormData(e.target)); await api('POST', '/api/' + x.what, { user_id: id, amount: x.amount, note: x.note }); toast('اتضاف'); openFinance(id, per); V.finance(); };
  const settle = async kind => { await api('POST', `/api/finance/${id}/settle`, { kind, period: $('#per').value }); toast('اتقفل'); openFinance(id, per); V.finance(); };
  $('#sm').onclick = () => settle('month'); $('#se').onclick = () => settle('early');
  document.querySelectorAll('[data-paid]').forEach(b => (b.onclick = async () => { await api('PATCH', '/api/settlements/' + b.dataset.paid); toast('اتسجل الدفع'); openFinance(id, per); }));
  document.querySelectorAll('[data-del]').forEach(b => (b.onclick = async () => { if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = 'متأكد؟'; return; } await api('DELETE', '/api/' + b.dataset.del); toast('اتمسح'); openFinance(id, per); V.finance(); }));
}

/* ----- subscriptions (cs/admin) ----- */
V.subs = async () => {
  const [bs, hist] = await Promise.all([api('GET', '/api/batches'), api('GET', '/api/subs')]);
  $('#main').innerHTML = `<h2>تسجيل الاشتراكات</h2><p class="note">كل 7 أيام سجّل عدد اشتراكات كل دفعة من Nerdio. الرقم بيتقارن بالعدد المتوقع للدفعة.</p>
  <form id="sf" class="panel"><label style="max-width:14em">التاريخ<input type="date" name="day" value="${esc(ME.today)}"></label><table class="stack"><thead><tr><th>الدفعة</th><th class="n">آخر رقم</th><th class="n">المتوقع</th><th>العدد الحالي</th></tr></thead><tbody>${bs.map(b => `<tr><td><b dir="ltr">${esc(b.code)}</b> <span class="mut">${esc(b.uni)} · ${esc(b.year)}</span></td><td class="n">${b.subs ?? '—'}</td><td class="n">${b.expected_subs || '—'}</td><td><input type="number" min="0" data-b="${b.id}" style="max-width:8em"></td></tr>`).join('')}</tbody></table><button class="btn a">حفظ الأرقام</button></form>
  <section class="panel"><h3>آخر التسجيلات</h3>${hist.length ? `<table class="stack"><tbody>${hist.slice(0, 60).map(h => `<tr><td dir="ltr">${esc(h.code)}</td><td>${esc(h.day)}</td><td class="n">${h.count}</td><td>${ME.role === 'admin' ? `<button class="btn sm g" data-sdel="${h.id}">مسح</button>` : ''}</td></tr>`).join('')}</tbody></table>` : empty('مفيش')}</section>`;
  document.querySelectorAll('[data-sdel]').forEach(b => (b.onclick = async () => { await api('DELETE', '/api/subs/' + b.dataset.sdel); toast('اتمسح'); V.subs(); }));
  $('#sf').onsubmit = async e => { e.preventDefault(); const rows = [...document.querySelectorAll('[data-b]')].filter(i => i.value !== '').map(i => ({ batch_id: i.dataset.b, count: i.value })); if (!rows.length) return toast('اكتب رقم واحد على الأقل'); await api('POST', '/api/subs', { day: new FormData(e.target).get('day'), rows }); toast('اتحفظ'); V.subs(); };
};
V.shift = async () => {
  const ns = await api('GET', '/api/shift');
  $('#main').innerHTML = `<h2>تسليم الشيفت</h2><p class="note">قبل ما تخلص شيفتك اكتب لزميلك إيه المفتوح وإيه محتاج متابعة.</p><form id="nf" class="panel"><textarea name="body" required rows="5"></textarea><button class="btn a">حفظ الملاحظة</button></form><section class="panel">${ns.map(n => `<div style="border-bottom:1px solid var(--line);padding:8px 0"><b>${esc(n.name)}</b> <span class="mut">${fmt(n.created_at)}</span><p style="white-space:pre-wrap;margin:4px 0">${esc(n.body)}</p></div>`).join('') || empty('مفيش')}</section>`;
  $('#nf').onsubmit = async e => { e.preventDefault(); await api('POST', '/api/shift', { body: new FormData(e.target).get('body') }); toast('اتحفظت'); V.shift(); };
};

/* ----- ranking (admin) ----- */
let RK = 'doctor';
V.ranking = async () => {
  const m = cache.rmonth || ME.today.slice(0, 7); const r = await api('GET', '/api/rankings?month=' + m); const list = r.lists[RK];
  $('#main').innerHTML = `<div class="row sp"><h2>ترتيب الشهر</h2><input type="month" id="rm" value="${esc(r.month)}" style="width:auto"></div><p class="note">الترتيب بيتحسب تلقائي من تقييم الشهر. تقدر تغيّر مركز أي حد بإيدك، والباقيين بيترتبوا حواليه.</p>
  <div class="tabs">${Object.entries(r.roles).map(([k, v]) => `<button data-rk="${k}" class="${k === RK ? 'on' : ''}">${v}</button>`).join('')}</div>
  <div class="panel" style="padding:6px 10px">${list.length ? `<table class="stack"><thead><tr><th class="n">المركز</th><th>الاسم</th><th class="n">التقييم</th><th>تفاصيل الشهر</th><th>تغيير المركز</th></tr></thead><tbody>${list.map(x => `<tr><td class="n"><b style="font-size:20px">${x.rank}</b>${x.manual ? `<div class="mut amber">يدوي (تلقائي: ${x.auto})</div>` : ''}</td><td><b>${esc(x.name)}</b></td><td class="n">${x.score ?? '—'}</td><td class="mut">${esc(x.detail)}</td><td><select data-rpos="${x.id}" style="max-width:9em">${opts([['', 'تلقائي'], ...list.map((_, i) => [i + 1, 'المركز ' + (i + 1)])], x.manual ? x.rank : '')}</select></td></tr>`).join('')}</tbody></table>` : empty('مفيش حد')}</div>`;
  $('#rm').onchange = () => { cache.rmonth = $('#rm').value; V.ranking(); };
  document.querySelectorAll('[data-rk]').forEach(b => (b.onclick = () => { RK = b.dataset.rk; V.ranking(); }));
  document.querySelectorAll('[data-rpos]').forEach(sl => (sl.onchange = async () => { await api('PUT', '/api/rankings', { month: r.month, role: RK, user_id: sl.dataset.rpos, position: sl.value || null }); toast('الترتيب اتعدّل'); V.ranking(); }));
};

/* ----- account ----- */
V.account = async () => {
  ME = await api('GET', '/api/me');
  let fin = '';
  if (ME.role !== 'admin') { const f = await api('GET', '/api/finance/' + ME.id); fin = `<section class="panel"><h3>حسابي المالي (الفترة الحالية)</h3>${finBody(f, false)}</section>`; }
  const rc = ME.role !== 'admin' ? await rankCard() : '';
  $('#main').innerHTML = `<h2>${esc(ME.name)}</h2><p class="note">${esc(ME.email)} · ${ROLE[ME.role]}</p>${rc}
  <section class="panel"><h3>بوت تليجرام</h3>${ME.linked ? '<p class="ok">حسابك مربوط بالبوت ✓</p>' : `<p>افتح بوت ${esc(ME.brand)} على تليجرام، ودوس Start، وابعت الكود ده:</p><p style="font-size:22px"><code>${esc(ME.link_code || '')}</code></p>`}</section>
  ${fin}
  ${ME.role !== 'admin' ? `<form id="ctf" class="panel"><h3>بيانات التواصل</h3><p class="mut">الإدارة هتكلمك عليها لو فيه أي حاجة في التحويل.</p><div class="two"><label>يوزر التليجرام<input name="tg_username" dir="ltr" placeholder="@username" value="${esc(ME.tg_username ? '@' + ME.tg_username : '')}"></label><label>رقم الواتساب<input name="whatsapp" dir="ltr" inputmode="tel" placeholder="01xxxxxxxxx" value="${esc(ME.whatsapp || '')}"></label></div><button class="btn sm">حفظ</button></form>
  <section class="panel" id="trl" hidden><h3>رسايل الحسابات</h3><div id="trc"></div></section>` : ''}
  ${ME.role !== 'admin' ? `<section class="panel"><h3>طرق استلام الفلوس</h3><p class="mut">الإدارة هتحوّلك على الطريقة اللي هتكتبها هنا. تقدر تضيف أكتر من طريقة.</p><div id="pyl"></div>
  <details><summary><b>+ إضافة طريقة تحويل</b></summary><form id="pyf" style="margin-top:10px"><label>الطريقة<select name="kind" id="pyk">${opts(Object.entries(PAYOUT), 'vodafone')}</select></label>
  <label>الاسم (زي ما هو في الحساب)<input name="name" required></label><div id="pyn"><label>الرقم<input name="number" dir="ltr" inputmode="tel"></label></div>
  <div id="pyb" hidden><label>اسم البنك<input name="bank"></label><label>الأيبان (IBAN)<input name="iban" dir="ltr"></label><label>رقم الحساب<input name="account" dir="ltr"></label></div><button class="btn a">حفظ</button></form></details></section>` : ''}
  <form id="pw" class="panel"><h3>تغيير كلمة المرور</h3><div class="two"><label>الحالية<input type="password" name="old" required></label><label>الجديدة (8 حروف على الأقل)<input type="password" name="new" minlength="8" required></label></div><button class="btn sm">تغيير</button></form>`;
  $('#pw').onsubmit = async e => { e.preventDefault(); await api('POST', '/api/me/password', Object.fromEntries(new FormData(e.target))); e.target.reset(); toast('اتغيرت'); };
  if ($('#ctf')) { $('#ctf').onsubmit = async e => { e.preventDefault(); await api('PUT', '/api/me/contact', Object.fromEntries(new FormData(e.target))); toast('اتحفظت ✓'); ME = await api('GET', '/api/me'); };
    const loadTr = () => api('GET', '/api/me/transfers').then(ts => { if (!ts.length) return; $('#trl').hidden = false;
      $('#trc').innerHTML = ts.map(t => `<div style="border-bottom:1px solid var(--line);padding:8px 0"><span class="mut">${fmt(t.created_at)}</span> ${trStatus(t)}${t.note ? `<div>${esc(t.note)}</div>` : ''}${t.has_file ? `<a href="/api/transfers/${t.id}/file" target="_blank" rel="noopener">${esc(t.file_name || 'الإيصال')}</a>` : ''}${t.settlement_id ? `${t.has_file ? ' · ' : ''}<a href="/api/settlements/${t.settlement_id}/pdf" target="_blank" rel="noopener">كشف الحساب PDF</a>` : ''}${t.problem ? `<div class="red">المشكلة اللي بلّغت عنها: ${esc(t.problem)}</div>` : ''}
        ${t.needs_confirm && !t.confirmed_at && !t.problem ? `<div class="row" style="margin-top:6px"><button class="btn a sm" data-trc="${t.id}">استلمت ✓</button><button class="btn g sm" data-trx="${t.id}">فيه مشكلة</button></div>` : ''}</div>`).join('');
      document.querySelectorAll('[data-trc]').forEach(b => (b.onclick = async () => { await api('POST', `/api/me/transfers/${b.dataset.trc}/confirm`); toast('اتسجل إنك استلمت ✓'); loadTr(); }));
      document.querySelectorAll('[data-trx]').forEach(b => (b.onclick = () => { modal('<b>مشكلة في التحويل</b>', '<form id="txf"><textarea name="text" required placeholder="مثلاً: التحويل ماوصلش، أو المبلغ ناقص"></textarea><button class="btn a">إرسال للإدارة</button></form>'); $('#txf').onsubmit = async e => { e.preventDefault(); await api('POST', `/api/me/transfers/${b.dataset.trx}/problem`, { text: new FormData(e.target).get('text') }); dlg.close(); toast('وصلت للإدارة ✓'); loadTr(); }; }));
    });
    loadTr(); }
  if ($('#pyf')) {
    const loadPy = async () => { $('#pyl').innerHTML = payoutHtml(await api('GET', '/api/me/payout'), true); document.querySelectorAll('[data-pdel]').forEach(b => (b.onclick = async () => { await api('DELETE', '/api/me/payout/' + b.dataset.pdel); toast('اتمسحت'); loadPy(); })); };
    const tog = () => { const bank = $('#pyk').value === 'bank'; $('#pyb').hidden = !bank; $('#pyn').hidden = bank; };
    $('#pyk').onchange = tog; tog(); loadPy();
    $('#pyf').onsubmit = async e => { e.preventDefault(); await api('POST', '/api/me/payout', Object.fromEntries(new FormData(e.target))); e.target.reset(); tog(); toast('اتحفظت ✓'); loadPy(); };
  }
};

/* ----- audit log (admin) ----- */
V.audit = async () => {
  const f = cache.audit || {}, qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const r = await api('GET', '/api/audit?' + qs);
  const row = a => `<tr><td class="mut" style="white-space:nowrap">${fmt(a.at)}</td><td><b>${esc(a.name)}</b><div class="mut">${ROLE[a.role] || ''}${a.admin_name ? ` · <span class="red">الأدمن ${esc(a.admin_name)} وهو داخل على حسابه</span>` : ''}</div></td><td>${esc(a.what)}${a.target ? `<div><b>${esc(a.target)}</b></div>` : ''}${a.extra ? `<div class="mut">${esc(a.extra)}</div>` : ''}</td></tr>`;
  $('#main').innerHTML = `<h2>سجل العمليات</h2><p class="note">كل حاجة اتعملت في اللوحة والبوت: مين عمل إيه وإمتى. الأحدث فوق.</p>
  <div class="panel row"><select id="auu" style="width:auto">${opts(r.users.map(x => [x.id, `${x.name} · ${ROLE[x.role]}`]), f.user, 'كل الناس')}</select><input type="date" id="aud" value="${esc(f.day || '')}" style="width:auto"><button class="btn g sm" id="aur">مسح الفلتر</button></div>
  <div class="panel" style="padding:6px 10px">${r.rows.length ? `<table class="stack"><thead><tr><th>الوقت</th><th>مين</th><th>عمل إيه</th></tr></thead><tbody id="aub">${r.rows.map(row).join('')}</tbody></table>` : empty('مفيش عمليات')}${r.more ? '<button class="btn g sm" id="aum" style="margin-top:8px">أقدم</button>' : ''}</div>`;
  const set = () => { cache.audit = { user: $('#auu').value, day: $('#aud').value }; V.audit(); };
  $('#auu').onchange = set; $('#aud').onchange = set; $('#aur').onclick = () => { cache.audit = {}; V.audit(); };
  let more = r.more;
  if ($('#aum')) $('#aum').onclick = async () => { const x = await api('GET', '/api/audit?' + new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), before: more })); $('#aub').insertAdjacentHTML('beforeend', x.rows.map(row).join('')); more = x.more; if (!more) $('#aum').remove(); };
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
    <div class="panel" style="padding:6px 10px"><table class="stack"><thead><tr><th>الاسم</th><th>الدور</th><th>الإيميل</th><th>البوت</th><th></th></tr></thead><tbody>${us.map(u => `<tr${u.active ? '' : ' style="opacity:.5"'}><td><b>${esc(u.name)}</b>${u.role !== 'doctor' && u.role !== 'admin' ? `<div class="mut">مرتب ${money(u.salary)}</div>` : ''}</td><td>${ROLE[u.role]}</td><td dir="ltr">${esc(u.email)}</td><td>${u.linked ? '<span class="ok">مربوط ✓</span>' : `<code>${esc(u.link_code)}</code>`}</td><td><button class="btn g sm" data-ue="${u.id}">تعديل</button>${u.role !== 'admin' && u.active ? ` <button class="btn g sm" data-imp="${u.id}">ادخل كـ ${esc(u.name.split(' ').slice(0, 2).join(' '))}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
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
    const fl = (k, l, h) => `<label>${l}<input name="${k}" dir="ltr" inputmode="decimal" value="${esc(s[k] === '0' ? '' : s[k] || '')}" placeholder="مقفول"><small class="mut">${h}</small></label>`;
    body = `<form id="gf" class="panel"><div class="two">${f('brand', 'الاسم', 'text')}${f('deadline_hours', 'مهلة الدكتور (ساعات)')}${f('upload_minutes', 'مهلة الرفع (دقايق)')}${f('coord_reply_minutes', 'مهلة مسؤول الدفعة في الرد (دقايق)')}${f('cs_reply_minutes', 'مهلة خدمة العملاء (دقايق)')}${f('exam_alert_days', 'تنبيه الامتحان قبلها بـ (أيام)')}${f('report_time', 'ميعاد التقرير اليومي', 'time')}${f('backup_time', 'ميعاد الباك أب', 'time')}</div>
    <h3 style="margin-top:16px">التنبيهات</h3><p class="mut">اكتب الأوقات اللي عايز التنبيه يتبعت فيها، أرقام بينها فاصلة (زي <span dir="ltr">6, 3, 1</span>). سيبها فاضية عشان توقف التنبيه ده.</p>
    <div class="two">${fl('remind_before_hours', 'تذكير الدكتور قبل الديدلاين بـ (ساعات)', 'للدكتور. بعد الديدلاين: إنذار مرة كل يوم تأخير للدكتور والمسؤول والمشرف وليك')}${fl('upload_alert_minutes', 'ملفات اتعتمدت ومااترفعتش، بعد (دقايق)', 'للمسؤول، وبعد مهلة الرفع للمشرف كمان')}${fl('send_alert_minutes', 'سؤال مااتبعتش للدكتور، بعد (دقايق)', 'للمسؤول، وبعد مهلته للمشرف كمان')}${fl('return_alert_minutes', 'رد الدكتور مارجعش لخدمة العملاء، بعد (دقايق)', 'للمسؤول، وبعد مهلته للمشرف كمان')}${fl('deliver_alert_minutes', 'الرد ماوصلش للطالب، بعد (دقايق)', 'لخدمة العملاء، وبعد مهلتها ليك')}${fl('doctor_reply_alert_hours', 'الدكتور مارد على سؤال، بعد (ساعات)', 'للدكتور ولمسؤول الدفعة (لو السؤال مالوش مهلة)')}${fl('due_alert_minutes', 'قبل مهلة السؤال/المشكلة بـ (دقايق)', 'للي السؤال واقف عنده. ولو المهلة عدّت: للكل')}${f('sup_grace_minutes', 'مهلة المشرف بعد تأخير المسؤول (دقايق) — بعدها التأخير على الاتنين')}</div>
    <button class="btn a">حفظ</button></form><div class="panel"><h3>الباك أب</h3><p class="mut">بيتعمل تلقائي كل يوم ويتبعت لقناة تليجرام الخاصة.</p><button class="btn g" id="bk">اعمل باك أب دلوقتي</button></div><form id="rst" class="panel" style="border-color:var(--red)"><h3 class="red">مسح كل بيانات التجربة</h3><p>بيمسح كل المحاضرات، والتذاكر، والمهام، والتقارير، والاشتراكات، والعقوبات، والبونص، والتقفيلات، والترتيب. الحسابات والجامعات والدفعات والإعدادات بتفضل زي ما هي، وبيتعمل باك أب قبل المسح.</p><label class="chk"><input type="checkbox" name="doctors"> امسح كمان كل حسابات الدكاترة</label><label>اكتب <b>امسح كل حاجة</b> للتأكيد<input name="confirm" autocomplete="off"></label><button class="btn r">مسح نهائي</button></form>`;
  }
  $('#main').innerHTML = `<h2>الإعدادات</h2><div class="tabs">${Object.entries(tabs).map(([k, v]) => `<button data-st="${k}" class="${k === ST ? 'on' : ''}">${v}</button>`).join('')}</div>${body}`;
  document.querySelectorAll('[data-st]').forEach(b => (b.onclick = () => { ST = b.dataset.st; V.settings(); }));
  if ($('#uf')) { const tog = () => { const d = $('#ur').value === 'doctor'; $('#dcf').hidden = !d; $('#sal').hidden = d || $('#ur').value === 'admin'; }; $('#ur').onchange = tog; tog();
    $('#uf').onsubmit = async e => { e.preventDefault(); const r = await api('POST', '/api/users', Object.fromEntries(new FormData(e.target))); toast('اتضاف · كود البوت ' + r.link_code); V.settings(); }; }
  document.querySelectorAll('[data-imp]').forEach(b => (b.onclick = async () => { await api('POST', '/api/impersonate/' + b.dataset.imp); location.hash = ''; await boot(); }));
  document.querySelectorAll('[data-ue]').forEach(b => (b.onclick = () => {
    const u = cache.users.find(x => x.id === Number(b.dataset.ue));
    modal(`<b>${esc(u.name)}</b>`, `<form id="ef"><div class="two"><label>الاسم<input name="name" value="${esc(u.name)}"></label><label>الإيميل<input name="email" dir="ltr" value="${esc(u.email)}"></label></div><div class="two"><label>الموبايل<input name="phone" dir="ltr" value="${esc(u.phone || '')}"></label>${u.role !== 'doctor' ? `<label>المرتب<input name="salary" type="number" step="0.01" value="${u.salary}"></label>` : ''}</div><label>كلمة مرور جديدة (سيبها فاضية لو مش عايز تغيّر)<input name="password" dir="ltr" minlength="8"></label><label class="chk"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> الحساب شغال</label><label class="chk"><input type="checkbox" name="new_code"> كود ربط جديد (بيفك ربط البوت الحالي)</label><div class="row sp"><button class="btn">حفظ</button><button type="button" class="btn r sm" id="udel">مسح المستخدم</button></div></form>`);
    $('#udel').onclick = async () => { if (!$('#udel').dataset.sure) { $('#udel').dataset.sure = 1; $('#udel').textContent = 'متأكد؟ دوس تاني'; return; } await api('DELETE', '/api/users/' + u.id); dlg.close(); toast('اتمسح'); V.settings(); };
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
  if ($('#rst')) $('#rst').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target); await api('POST', '/api/reset', { confirm: f.get('confirm'), doctors: !!f.get('doctors') }); toast('كل بيانات التجربة اتمسحت'); V.settings(); };
  if ($('#bk')) $('#bk').onclick = async () => { const r = await api('POST', '/api/backup'); toast(r.ok ? 'الباك أب اتعمل' : 'حصلت مشكلة'); };
};

boot();
setInterval(() => { if (ME && !dlg.open && !document.activeElement?.matches('input,textarea,select') && ['home', 'lectures', 'tickets'].includes(view)) render(); }, 60000);
}
