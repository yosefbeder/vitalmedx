'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'vitalmedx.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, pass TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','supervisor','coordinator','cs','doctor')),
  active INTEGER NOT NULL DEFAULT 1, salary REAL NOT NULL DEFAULT 0, tg_id TEXT, phone TEXT,
  link_code TEXT UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS doctors(
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  price_theory REAL NOT NULL DEFAULT 0, price_practical REAL NOT NULL DEFAULT 0, price_revision REAL NOT NULL DEFAULT 0,
  capacity INTEGER NOT NULL DEFAULT 3, adj INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS universities(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS batches(
  id INTEGER PRIMARY KEY, university_id INTEGER NOT NULL REFERENCES universities(id),
  year TEXT NOT NULL, code TEXT UNIQUE NOT NULL,
  supervisor_id INTEGER REFERENCES users(id), coordinator_id INTEGER REFERENCES users(id),
  expected_subs INTEGER NOT NULL DEFAULT 0, exam_date TEXT, exam_note TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS lectures(
  id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES batches(id), doctor_id INTEGER NOT NULL REFERENCES users(id),
  coordinator_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK(type IN ('theory','practical','revision','repeat')), name TEXT NOT NULL, price REAL NOT NULL,
  sent_at INTEGER NOT NULL, lec_file TEXT, src_q_file TEXT,
  video_file TEXT, video_at INTEGER, q_file TEXT, q_at INTEGER, video_ok_at INTEGER, q_ok_at INTEGER,
  r_video INTEGER, r_q INTEGER, r_instr INTEGER, r_comm INTEGER, uploaded_at INTEGER,
  reminded INTEGER NOT NULL DEFAULT 0, overdue_notified INTEGER NOT NULL DEFAULT 0, settlement_id INTEGER);
CREATE INDEX IF NOT EXISTS lec_doc ON lectures(doctor_id); CREATE INDEX IF NOT EXISTS lec_batch ON lectures(batch_id);
CREATE TABLE IF NOT EXISTS price_log(id INTEGER PRIMARY KEY, lecture_id INTEGER, old REAL, new REAL, by INTEGER, at INTEGER);
CREATE TABLE IF NOT EXISTS tickets(
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('question','problem')), batch_id INTEGER NOT NULL REFERENCES batches(id),
  lecture_id INTEGER REFERENCES lectures(id), doctor_id INTEGER REFERENCES users(id), body TEXT NOT NULL, student TEXT,
  created_by INTEGER NOT NULL, created_at INTEGER NOT NULL, sent_doctor_at INTEGER, tg_msg_id INTEGER,
  reply TEXT, reply_at INTEGER, returned_at INTEGER, returned_by INTEGER, delivered_at INTEGER, delivered_by INTEGER,
  resolution TEXT, closed_at INTEGER);
CREATE TABLE IF NOT EXISTS checklist(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, period TEXT NOT NULL, item TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, note TEXT, done_at INTEGER, UNIQUE(user_id, period, item));
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, day TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(user_id, day));
CREATE TABLE IF NOT EXISTS subs(id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, by INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS penalties(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, reason TEXT NOT NULL, kind TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'proposed', proposed_by INTEGER, decided_by INTEGER, created_at INTEGER NOT NULL, decided_at INTEGER,
  objection TEXT, reply TEXT, settlement_id INTEGER);
CREATE TABLE IF NOT EXISTS bonuses(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, amount REAL NOT NULL, note TEXT, by INTEGER, created_at INTEGER NOT NULL, settlement_id INTEGER);
CREATE TABLE IF NOT EXISTS extra_pay(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, amount REAL NOT NULL, note TEXT, by INTEGER, created_at INTEGER NOT NULL, settlement_id INTEGER);
CREATE TABLE IF NOT EXISTS settlements(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, period TEXT NOT NULL,
  gross REAL NOT NULL, bonus REAL NOT NULL, deductions REAL NOT NULL, net REAL NOT NULL, detail TEXT, paid_at INTEGER, by INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS shift_notes(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bot_pending(id INTEGER PRIMARY KEY, tg_id TEXT NOT NULL, kind TEXT NOT NULL, file_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL);
`);

if (!db.prepare("SELECT 1 FROM pragma_table_info('lectures') WHERE name='no_q'").get()) db.exec('ALTER TABLE lectures ADD COLUMN no_q INTEGER NOT NULL DEFAULT 0');
for (const [c, d] of [['priority', 'INTEGER NOT NULL DEFAULT 1'], ['queue_pos', 'INTEGER'], ['excused', 'INTEGER NOT NULL DEFAULT 0'], ['excuse_note', 'TEXT']]) if (!db.prepare("SELECT 1 FROM pragma_table_info('lectures') WHERE name=?").get(c)) db.exec(`ALTER TABLE lectures ADD COLUMN ${c} ${d}`);
for (const [c, d] of [['att_path', 'TEXT'], ['att_name', 'TEXT'], ['att_mime', 'TEXT'], ['att_file_id', 'TEXT'], ['att_msg_id', 'INTEGER'], ['reply_file_id', 'TEXT'], ['reply_kind', 'TEXT']]) if (!db.prepare("SELECT 1 FROM pragma_table_info('tickets') WHERE name=?").get(c)) db.exec(`ALTER TABLE tickets ADD COLUMN ${c} ${d}`);
for (const [c, d] of [['tg_username', 'TEXT'], ['whatsapp', 'TEXT']]) if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name=?").get(c)) db.exec(`ALTER TABLE users ADD COLUMN ${c} ${d}`);
db.exec('CREATE TABLE IF NOT EXISTS transfer_msgs(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, note TEXT, file_path TEXT, file_name TEXT, mime TEXT, by INTEGER, delivered INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)');
db.exec(`CREATE TABLE IF NOT EXISTS payout_methods(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('vodafone','instapay','bank')), name TEXT, number TEXT, bank TEXT, iban TEXT, account TEXT, created_at INTEGER NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS bot_drafts(id INTEGER PRIMARY KEY, tg_id TEXT NOT NULL, kind TEXT, body TEXT, file_id TEXT, file_kind TEXT, batch_id INTEGER, created_at INTEGER NOT NULL)`);
if (!db.prepare("SELECT 1 FROM pragma_table_info('tickets') WHERE name='att_kind'").get()) db.exec('ALTER TABLE tickets ADD COLUMN att_kind TEXT');
const addCol = (t, c, d) => { if (db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name=?`).get(c)) return false; db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); return true; };
for (const [c, d] of [['lecture_id', 'INTEGER'], ['await_student', 'INTEGER NOT NULL DEFAULT 0']]) addCol('bot_drafts', c, d);
for (const [c, d] of [['needs_confirm', 'INTEGER NOT NULL DEFAULT 0'], ['confirmed_at', 'INTEGER'], ['problem', 'TEXT'], ['problem_at', 'INTEGER'], ['problem_msg_id', 'INTEGER'], ['problem_wait', 'INTEGER'], ['reminded', 'INTEGER NOT NULL DEFAULT 0'], ['settlement_id', 'INTEGER']]) addCol('transfer_msgs', c, d);
if (addCol('lectures', 'late_alerted', 'INTEGER NOT NULL DEFAULT 0')) db.exec('UPDATE lectures SET late_alerted=overdue_notified'); // don't re-alert old lates after upgrade
addCol('audit', 'as_admin', 'INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS audit_at ON audit(at)');
// v1.7: lecture kind, ticket priority/deadline, who-did-it, alerts log, password reset
for (const [c, d] of [['kind', "TEXT NOT NULL DEFAULT 'new'"], ['ok_by', 'INTEGER'], ['uploaded_by', 'INTEGER']]) if (addCol('lectures', c, d) && c === 'kind') db.exec("UPDATE lectures SET kind='repeat', type='theory' WHERE type='repeat'");
for (const [c, d] of [['priority', 'INTEGER NOT NULL DEFAULT 1'], ['due_at', 'INTEGER'], ['sent_by', 'INTEGER'], ['closed_by', 'INTEGER'], ['direct', 'INTEGER NOT NULL DEFAULT 0'], ['reply_path', 'TEXT'], ['reply_mime', 'TEXT'], ['reply_name', 'TEXT']]) addCol('tickets', c, d);
for (const [c, d] of [['doctor_id', 'INTEGER'], ['student', 'TEXT'], ['priority', 'INTEGER'], ['stage', 'TEXT'], ['route', 'TEXT']]) addCol('bot_drafts', c, d);
// v1.8: revision covers, coordinator self-replies, chats, multi exams, bot flows, single CS
addCol('lectures', 'covers', 'TEXT');
for (const [c, d] of [['replied_by', 'INTEGER'], ['cr_msg_id', 'INTEGER']]) addCol('tickets', c, d);
db.exec('CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, body TEXT, file_id TEXT, file_kind TEXT, path TEXT, mime TEXT, name TEXT, tg_msg_id INTEGER, read_at INTEGER, created_at INTEGER NOT NULL)');
db.exec('CREATE INDEX IF NOT EXISTS msg_pair ON messages(from_id, to_id, created_at)');
db.exec('CREATE TABLE IF NOT EXISTS bot_flows(tg_id TEXT PRIMARY KEY, kind TEXT NOT NULL, step TEXT, data TEXT, prompt_id INTEGER, at INTEGER NOT NULL)');
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='exams'").get()) {
  db.exec('CREATE TABLE exams(id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, date TEXT NOT NULL, name TEXT, created_by INTEGER, created_at INTEGER NOT NULL)');
  for (const b of db.prepare('SELECT id, exam_date, exam_note FROM batches WHERE exam_date IS NOT NULL').all()) db.prepare('INSERT INTO exams(batch_id,date,name,created_at) VALUES(?,?,?,?)').run(b.id, b.exam_date, b.exam_note, Date.now());
}
if (!db.prepare("SELECT 1 FROM settings WHERE key='single_cs_v18'").get()) { // one customer-service account from now on (history kept)
  db.prepare("UPDATE users SET active=0 WHERE role='cs' AND email='cs2@vitalmedx.app'").run();
  db.prepare("INSERT INTO settings(key,value) VALUES('single_cs_v18','1')").run();
}
db.exec('CREATE TABLE IF NOT EXISTS reset_codes(user_id INTEGER PRIMARY KEY, code TEXT NOT NULL, exp INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL)');
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='alert_log'").get()) {
  db.exec('CREATE TABLE alert_log(key TEXT PRIMARY KEY, at INTEGER NOT NULL)');
  // lectures already alerted as late before the upgrade: mark today's daily alert as sent (no burst on upgrade)
  const dl = Number((db.prepare("SELECT value FROM settings WHERE key='deadline_hours'").get() || {}).value || 24) * 3600e3, n = Date.now();
  for (const l of db.prepare('SELECT id, sent_at FROM lectures WHERE late_alerted=1 AND (video_at IS NULL OR q_at IS NULL)').all()) {
    const day = Math.floor((n - l.sent_at - dl) / 864e5) + 1; for (let d = 1; d <= day; d++) db.prepare('INSERT OR IGNORE INTO alert_log(key,at) VALUES(?,?)').run(`late:${l.id}:${d}`, n);
  }
}
db.exec('CREATE TABLE IF NOT EXISTS doctor_notes(id INTEGER PRIMARY KEY, doctor_id INTEGER NOT NULL, by INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)');
db.exec('CREATE TABLE IF NOT EXISTS rank_overrides(month TEXT NOT NULL, role TEXT NOT NULL, user_id INTEGER NOT NULL, position INTEGER NOT NULL, by INTEGER, at INTEGER, PRIMARY KEY(month, role, user_id))');

const DEFAULTS = {
  deadline_hours: '24', remind_hours: '6', upload_minutes: '30', coord_reply_minutes: '60', cs_reply_minutes: '30',
  exam_alert_days: '10', report_time: '23:00', backup_time: '03:00', repeat_ratio: '0.5', brand: 'VitalMedX',
  // alerts: comma-separated lists the admin edits from Settings → التنبيهات
  doctor_reply_alert_hours: '3', remind_before_hours: '', upload_alert_minutes: '30,60', send_alert_minutes: '60', return_alert_minutes: '60,120', deliver_alert_minutes: '30,60', due_alert_minutes: '30', sup_grace_minutes: '30',
};
for (const [k, v] of Object.entries(DEFAULTS)) db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(k, v);
if (!(db.prepare("SELECT value FROM settings WHERE key='remind_before_hours'").get() || {}).value) db.prepare("UPDATE settings SET value=? WHERE key='remind_before_hours'").run(String((db.prepare("SELECT value FROM settings WHERE key='remind_hours'").get() || {}).value || '6') + ',1');

const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const setting = k => (one('SELECT value FROM settings WHERE key=?', k) || {}).value ?? DEFAULTS[k];
const num = k => Number(setting(k));
const audit = (user_id, action, detail, asAdmin) => run('INSERT INTO audit(user_id,action,detail,at,as_admin) VALUES(?,?,?,?,?)', user_id ?? null, action, detail ? JSON.stringify(detail) : null, Date.now(), asAdmin ?? null);
function tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }

module.exports = { db, one, all, run, setting, num, audit, tx, DB_PATH, DATA_DIR };
