'use strict';
// Actions shared by the dashboard (server.js) and the Telegram bot (bot.js).
const { one, all, run } = require('./db');
const L = require('./logic');

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };
const int = v => (v === '' || v == null ? null : Number.parseInt(v, 10));
const real = v => (v === '' || v == null ? null : Number(v));
const str = (v, max = 4000) => (v == null ? null : String(v).trim().slice(0, max));
const req1 = (v, name) => { if (v == null || v === '' || Number.isNaN(v)) fail(400, `${name} مطلوب`); return v; };
const canBatch = (u, bid) => { const ids = L.batchIds(u); return u.role !== 'doctor' && (!ids || ids.includes(Number(bid))); };

// covers: lecture ids of the same batch a revision is about
function parseCovers(raw, bid) {
  const ids = (Array.isArray(raw) ? raw : String(raw || '').split(/[,\s]+/)).map(Number).filter(Boolean);
  if (!ids.length) return [];
  return all(`SELECT id FROM lectures WHERE batch_id=? AND id IN (${ids.map(() => '?').join(',')})`, bid, ...ids).map(r => r.id);
}

async function createLecture(u, body, files = {}) {
  const bot = require('./bot');
  if (!['admin', 'coordinator', 'supervisor'].includes(u.role)) fail(403, 'مش مسموح');
  const bid = req1(int(body.batch_id), 'الدفعة'); if (!canBatch(u, bid)) fail(403, 'الدفعة دي مش بتاعتك');
  const did = req1(int(body.doctor_id), 'الدكتور'); const doc = one('SELECT u.*, d.* FROM users u JOIN doctors d ON d.user_id=u.id WHERE u.id=? AND u.active=1', did) || fail(400, 'الدكتور مش موجود');
  const type = body.type in L.TYPES ? body.type : fail(400, 'النوع غلط');
  const kind = body.kind in L.KINDS ? body.kind : 'new';
  const name = req1(str(body.name, 200), 'اسم المحاضرة');
  const price = kind === 'repeat' ? (real(body.price) ?? fail(400, 'اكتب سعر المحاضرة المعادة بإيدك')) : (real(body.price) ?? doc[`price_${type}`]);
  if (!(price >= 0)) fail(400, 'السعر غلط');
  const covers = type === 'revision' ? parseCovers(body.covers, bid) : [];
  const coord = u.role === 'coordinator' ? u.id : (one('SELECT coordinator_id FROM batches WHERE id=?', bid) || {}).coordinator_id || u.id;
  const noq = body.no_q === true || body.no_q === '1' || body.no_q === 'on', t0 = Date.now(), pr = Math.max(0, Math.min(3, int(body.priority) ?? 1));
  const r = run('INSERT INTO lectures(batch_id,doctor_id,coordinator_id,type,kind,name,price,sent_at,no_q,q_at,q_ok_at,priority,covers) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    bid, did, coord, type, kind, name, price, t0, noq ? 1 : 0, noq ? t0 : null, noq ? t0 : null, pr, covers.length ? JSON.stringify(covers) : null);
  const l = one('SELECT * FROM lectures WHERE id=?', Number(r.lastInsertRowid));
  const fl = [];
  if (files.lec) fl.push({ ...files.lec, field: 'lec_file', label: 'ملف المحاضرة' });
  if (files.qsrc) fl.push({ ...files.qsrc, field: 'src_q_file', label: 'مرجع ملف الأسئلة' });
  const sent = await bot.sendLecture(l, fl);
  const today = all('SELECT COUNT(*) n FROM lectures WHERE doctor_id=? AND sent_at>=?', did, L.dayStart())[0].n;
  return { id: l.id, delivered_to_bot: sent, over_capacity: today > doc.capacity, today, capacity: doc.capacity, doctor: doc.name };
}

// who may chat with whom
const CHAT_PEERS = { admin: ['admin', 'supervisor', 'coordinator', 'cs', 'doctor'], supervisor: ['admin', 'supervisor', 'coordinator', 'cs', 'doctor'], coordinator: ['admin', 'supervisor', 'coordinator', 'cs', 'doctor'], cs: ['admin', 'supervisor', 'coordinator'], doctor: ['admin', 'supervisor', 'coordinator'] };
const canChat = (a, b) => !!(a && b && a.id !== b.id && (CHAT_PEERS[a.role] || []).includes(b.role) && (CHAT_PEERS[b.role] || []).includes(a.role));
function chatContacts(u) {
  const roles = CHAT_PEERS[u.role] || [];
  let rows = all(`SELECT id, name, role, tg_id IS NOT NULL linked FROM users WHERE active=1 AND id!=? AND role IN (${roles.map(() => '?').join(',')}) ORDER BY role, name`, u.id, ...roles);
  if (u.role === 'doctor') { // a doctor sees the people of the batches he teaches + admins
    const bs = all('SELECT DISTINCT b.coordinator_id c, b.supervisor_id s FROM lectures l JOIN batches b ON b.id=l.batch_id WHERE l.doctor_id=?', u.id), keep = new Set(bs.flatMap(b => [b.c, b.s]));
    rows = rows.filter(r => r.role === 'admin' || keep.has(r.id));
  }
  return rows;
}
// a message both ways: saved, then delivered on the bot (reply to it = answer)
async function sendChat(from, to, { body, file } = {}) {
  const bot = require('./bot');
  if (!canChat(from, to)) fail(403, 'مش مسموح تكلّم الشخص ده');
  const text = str(body, 4000); if (!text && !file) fail(400, 'اكتب الرسالة');
  const r = run('INSERT INTO messages(from_id,to_id,body,file_id,file_kind,path,mime,name,created_at) VALUES(?,?,?,?,?,?,?,?,?)', from.id, to.id, text, file && file.file_id || null, file && file.kind || null, file && file.path || null, file && file.mime || null, file && file.name || null, Date.now());
  const id = Number(r.lastInsertRowid), delivered = await bot.deliverChat(one('SELECT * FROM messages WHERE id=?', id));
  return { id, delivered };
}

module.exports = { HttpError, fail, createLecture, parseCovers, canChat, chatContacts, sendChat, CHAT_PEERS };
