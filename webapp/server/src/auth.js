// Operator login: bcrypt password hashes, opaque session tokens in SQLite,
// httpOnly cookie. Single offline desk, so no JWT/OAuth machinery.

'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { AppError } = require('./errors');

const COOKIE = 'rs_session';
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters';
  return null;
}

function publicOperator(op) {
  return op && { id: op.id, name: op.name, username: op.username, role: op.role, active: !!op.active };
}

function createAuth(db, { sessionHours }) {
  const q = {
    byUsername: db.prepare('SELECT * FROM operators WHERE username = ?'),
    insertSession: db.prepare(`INSERT INTO sessions (token, operator_id, expires_at) VALUES (?, ?, datetime('now', ?))`),
    sessionOperator: db.prepare(
      `SELECT o.* FROM sessions s JOIN operators o ON o.id = s.operator_id
       WHERE s.token = ? AND s.expires_at > datetime('now') AND o.active = 1`,
    ),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    purge: db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')"),
  };

  function login(username, password) {
    const op = q.byUsername.get(String(username || '').trim());
    // Compare even when the user doesn't exist, so timing doesn't reveal usernames.
    const ok = bcrypt.compareSync(String(password || ''), op ? op.password_hash : DUMMY_HASH);
    if (!op || !ok || !op.active) throw new AppError(401, 'BAD_LOGIN', 'Wrong username or password');
    q.purge.run();
    const token = crypto.randomBytes(32).toString('hex');
    q.insertSession.run(token, op.id, `+${sessionHours} hours`);
    return { token, operator: publicOperator(op) };
  }

  function operatorFromRequest(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    return token ? q.sessionOperator.get(token) || null : null;
  }

  function cookieFor(token, maxAgeSeconds) {
    return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
  }

  const middleware = {
    requireAuth(req, res, next) {
      const op = operatorFromRequest(req);
      if (!op) return next(new AppError(401, 'NOT_LOGGED_IN', 'Please log in'));
      req.operator = op;
      next();
    },
    requireAdmin(req, res, next) {
      if (!req.operator || req.operator.role !== 'admin') return next(new AppError(403, 'ADMIN_ONLY', 'Only an admin can do this'));
      next();
    },
  };

  return {
    login,
    logout: (req) => {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) q.deleteSession.run(token);
    },
    operatorFromRequest,
    sessionCookie: (token) => cookieFor(token, sessionHours * 3600),
    clearCookie: () => cookieFor('', 0),
    ...middleware,
  };
}

module.exports = { createAuth, hashPassword, validatePassword, publicOperator };
