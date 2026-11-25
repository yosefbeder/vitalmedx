'use strict';
const crypto = require('node:crypto');
const { one } = require('./db');

const SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const DAYS = 14;

function hash(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function verify(pw, stored) {
  const [s, h] = String(stored).split(':');
  if (!s || !h) return false;
  const a = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function makeCookie(userId) {
  const v = `${userId}.${Date.now() + DAYS * 864e5}`;
  const secure = process.env.COOKIE_SECURE === '0' ? '' : '; Secure';
  return `sid=${v}.${sign(v)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DAYS * 86400}${secure}`;
}
const clearCookie = () => 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
function userFromReq(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 3) return null;
  const v = parts[0] + '.' + parts[1];
  const sig = Buffer.from(parts[2]), exp = Buffer.from(sign(v));
  if (sig.length !== exp.length || !crypto.timingSafeEqual(sig, exp)) return null;
  if (Number(parts[1]) < Date.now()) return null;
  const u = one('SELECT id,name,email,role,active,tg_id FROM users WHERE id=?', Number(parts[0]));
  return u && u.active ? u : null;
}
const linkCode = () => 'VM-' + Array.from(crypto.randomBytes(5), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

module.exports = { hash, verify, makeCookie, clearCookie, userFromReq, linkCode };
