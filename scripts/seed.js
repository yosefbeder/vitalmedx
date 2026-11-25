'use strict';
// يملا النظام بالهيكل الحقيقي: الجامعات والدفعات والمشرفين ومسؤولين الدفعات وخدمة العملاء.
// بيشتغل مرة واحدة بس (لو مفيش مستخدمين). الدكاترة بيتضافوا من اللوحة.
const crypto = require('node:crypto');
const { one, run, tx } = require('../src/db');
const A = require('../src/auth');

if (one('SELECT COUNT(*) n FROM users').n > 0) { console.log('النظام فيه بيانات قبل كده، مفيش حاجة اتعملت.'); process.exit(0); }
const pw = () => crypto.randomBytes(6).toString('base64url');
const out = [];
function user(name, email, role, pass = pw()) {
  const r = run('INSERT INTO users(name,email,pass,role,link_code,created_at) VALUES(?,?,?,?,?,?)', name, email, A.hash(pass), role, A.linkCode(), Date.now());
  out.push({ name, email, role, pass }); return Number(r.lastInsertRowid);
}
tx(() => {
  user('الأدمن', process.env.ADMIN_EMAIL || 'admin@vitalmedx.app', 'admin', process.env.ADMIN_PASSWORD || pw());
  const S = { msaleh: user('د. محمد صالح', 'mohamed.saleh@vitalmedx.app', 'supervisor'), menna: user('د. منة', 'menna@vitalmedx.app', 'supervisor') };
  const C = { walaa: user('ولاء', 'walaa@vitalmedx.app', 'coordinator'), hasnaa: user('حسناء', 'hasnaa@vitalmedx.app', 'coordinator'),
    tantawy: user('أحمد الطنطاوي', 'ahmed.tantawy@vitalmedx.app', 'coordinator'), salah: user('صلاح', 'salah@vitalmedx.app', 'coordinator'),
    mahmoud: user('محمود صالح', 'mahmoud.saleh@vitalmedx.app', 'coordinator') };
  user('خدمة العملاء 1', 'cs1@vitalmedx.app', 'cs'); user('خدمة العملاء 2', 'cs2@vitalmedx.app', 'cs');
  const U = {};
  for (const [code, name] of [['1', 'جامعة الملك فيصل'], ['N1', 'تمريض فيصل'], ['2', 'جامعة أم القرى'], ['3', 'جامعة المعرفة'], ['N3', 'تمريض المعرفة'], ['4', 'جامعة المجمعة'], ['5', 'جامعة القنفذة'], ['9', 'جامعة الحرس']])
    U[code] = Number(run('INSERT INTO universities(code,name) VALUES(?,?)', code, name).lastInsertRowid);
  const Y = { 0: 'تحضيري', 1: 'سنة أولى', 2: 'سنة تانية', 3: 'سنة تالتة', 4: 'سنة رابعة' };
  const B = (uni, years, coord, sup) => { for (const y of years) run('INSERT INTO batches(university_id,year,code,supervisor_id,coordinator_id) VALUES(?,?,?,?,?)', U[uni], Y[y], `${uni}-${y}`, S[sup], C[coord]); };
  B('1', [0, 1, 2, 3, 4], 'walaa', 'msaleh');
  B('N1', [1], 'tantawy', 'msaleh');
  B('4', [2, 3], 'hasnaa', 'msaleh');
  B('2', [4], 'hasnaa', 'msaleh');
  B('N3', [1], 'tantawy', 'msaleh');
  B('2', [0], 'mahmoud', 'menna');
  B('2', [2, 3], 'salah', 'menna');
  B('3', [1, 2, 3], 'salah', 'menna');
  B('9', [2, 3], 'mahmoud', 'menna');
  B('5', [3], 'tantawy', 'menna');
});
console.log('\nالحسابات اتعملت. احفظ كلمات المرور دي وغيّرها بعد أول دخول:\n');
for (const x of out) console.log(`${x.role.padEnd(12)} ${x.email.padEnd(34)} ${x.pass}  ${x.name}`);
console.log('\nكود التحضيري = 0 (مثلاً 1-0)، وتقدر تغيّره من الإعدادات.');
