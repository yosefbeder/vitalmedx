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
db.exec('CREATE TABLE IF NOT EXISTS rank_overrides(month TEXT NOT NULL, role TEXT NOT NULL, user_id INTEGER NOT NULL, position INTEGER NOT NULL, by INTEGER, at INTEGER, PRIMARY KEY(month, role, user_id))');

const DEFAULTS = {
  deadline_hours: '24', remind_hours: '6', upload_minutes: '30', coord_reply_minutes: '60', cs_reply_minutes: '30',
  exam_alert_days: '10', report_time: '23:00', backup_time: '03:00', repeat_ratio: '0.5', brand: 'VitalMedX',
};
for (const [k, v] of Object.entries(DEFAULTS)) db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(k, v);

const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const setting = k => (one('SELECT value FROM settings WHERE key=?', k) || {}).value ?? DEFAULTS[k];
const num = k => Number(setting(k));
const audit = (user_id, action, detail) => run('INSERT INTO audit(user_id,action,detail,at) VALUES(?,?,?,?)', user_id ?? null, action, detail ? JSON.stringify(detail) : null, Date.now());
function tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }

module.exports = { db, one, all, run, setting, num, audit, tx, DB_PATH, DATA_DIR };
