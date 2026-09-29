'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const layout = require('./nfc/card-layout');
const { getSettings, setSetting } = require('./db');
const { createAuth, hashPassword, validatePassword, publicOperator } = require('./auth');
const { Desk, validateConsumerInput } = require('./services/desk');
const reports = require('./services/reports');
const { AppError, badRequest, notFound, conflict } = require('./errors');

// Wraps async handlers so rejections reach the error middleware.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createApp({ db, reader, config }) {
  const app = express();
  const auth = createAuth(db, { sessionHours: config.sessionHours });
  const desk = new Desk(db, reader);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // --- card taps -> websocket ------------------------------------------------

  let lastTap = null; // the most recent 'card' event, while the card stays on the reader

  function cardEvent({ uid, card, error }) {
    if (error || !card) return { type: 'card', uid, card: null, record: null, error };
    try {
      desk.recordTap(card);
      return { type: 'card', uid, card, record: desk.describe(card), error: null };
    } catch (err) {
      return { type: 'card', uid, card, record: null, error: `Database lookup failed: ${err.message}` };
    }
  }

  const sockets = new Set();
  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(data);
  };

  reader.on('status', (status) => broadcast({ type: 'status', status }));
  reader.on('card', (tap) => {
    lastTap = cardEvent(tap);
    broadcast(lastTap);
  });
  reader.on('removed', ({ uid }) => {
    lastTap = null;
    broadcast({ type: 'removed', uid });
  });

  function attachWebSocket(server) {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      if (!req.url.startsWith('/ws') || !auth.operatorFromRequest(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.add(ws);
        ws.on('close', () => sockets.delete(ws));
        ws.send(JSON.stringify({ type: 'status', status: reader.status() }));
        if (lastTap) ws.send(JSON.stringify(lastTap));
      });
    });
  }

  // --- auth ------------------------------------------------------------------

  const api = express.Router();

  api.post('/auth/login', (req, res) => {
    const { token, operator } = auth.login(req.body.username, req.body.password);
    res.setHeader('Set-Cookie', auth.sessionCookie(token));
    res.json({ operator });
  });

  api.post('/auth/logout', (req, res) => {
    auth.logout(req);
    res.setHeader('Set-Cookie', auth.clearCookie());
    res.json({ ok: true });
  });

  api.use(auth.requireAuth);

  api.get('/auth/me', (req, res) => res.json({ operator: publicOperator(req.operator) }));

  api.post('/auth/password', (req, res) => {
    const { current, next } = req.body;
    const bcrypt = require('bcryptjs');
    if (!bcrypt.compareSync(String(current || ''), req.operator.password_hash)) throw badRequest('Current password is wrong', { fields: { current: 'Wrong password' } });
    const err = validatePassword(next);
    if (err) throw badRequest(err, { fields: { next: err } });
    db.prepare('UPDATE operators SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.operator.id);
    res.json({ ok: true });
  });

  // --- reader / cards --------------------------------------------------------

  api.get('/status', (req, res) => {
    const s = getSettings(db);
    res.json({
      reader: reader.status(),
      settings: { initialCreditPaise: s.initialCreditPaise, minRechargePaise: s.minRechargePaise, maxRechargePaise: s.maxRechargePaise, tariff: s.tariff },
    });
  });

  api.get('/cards/current', (req, res) => res.json({ tap: lastTap }));

  api.post(
    '/cards/reread',
    h(async (req, res) => {
      try {
        await reader.rereadCard();
      } catch (err) {
        throw new AppError(err.code === 'NO_READER' ? 503 : 409, err.code || 'READ_FAILED', err.message);
      }
      res.json({ tap: lastTap });
    }),
  );

  api.post(
    '/cards/issue',
    h(async (req, res) => {
      const result = await desk.issueCard(req.body, req.operator);
      if (result.card) {
        lastTap = cardEvent({ uid: result.card.uid, card: result.card });
        broadcast(lastTap);
      }
      res.json(result);
    }),
  );

  api.post(
    '/cards/recharge',
    h(async (req, res) => {
      const result = await desk.recharge(req.body, req.operator);
      if (result.card) {
        lastTap = cardEvent({ uid: result.card.uid, card: result.card });
        broadcast(lastTap);
      }
      res.json(result);
    }),
  );

  api.get('/transactions/:id', (req, res) => {
    const txn = db
      .prepare(
        `SELECT t.*, c.name AS consumer_name, c.mobile, c.address, o.name AS operator_name FROM recharge_transactions t
         JOIN consumers c ON c.id = t.consumer_id LEFT JOIN operators o ON o.id = t.operator_id WHERE t.id = ?`,
      )
      .get(req.params.id);
    if (!txn) throw notFound('Transaction not found');
    res.json({ transaction: txn });
  });

  // --- consumers ---------------------------------------------------------------

  // Search is open to operators (needed to issue a replacement card); the
  // detail view, edits and card status are admin-only.
  api.get('/consumers', (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const where = q ? 'WHERE c.name LIKE @like OR c.mobile LIKE @like OR c.meter_number LIKE @like OR c.id = @id' : '';
    const params = { like: `%${q}%`, id: /^\d+$/.test(q) ? Number(q) : -1 };
    const rows = db
      .prepare(
        `SELECT c.*,
           (SELECT COUNT(*) FROM cards k WHERE k.consumer_id = c.id AND k.status = 'active') AS active_cards,
           (SELECT GROUP_CONCAT(k.card_uid) FROM cards k WHERE k.consumer_id = c.id AND k.status = 'active') AS active_card_uids,
           (SELECT MAX(t.timestamp) FROM recharge_transactions t WHERE t.consumer_id = c.id AND t.status = 'completed') AS last_recharge_at
         FROM consumers c ${where} ORDER BY c.name COLLATE NOCASE LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit, offset });
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM consumers c ${where}`).get(params);
    res.json({ consumers: rows, total });
  });

  api.get('/consumers/:id', auth.requireAdmin, (req, res) => {
    const consumer = db.prepare('SELECT * FROM consumers WHERE id = ?').get(req.params.id);
    if (!consumer) throw notFound('Consumer not found');
    const cards = db.prepare('SELECT * FROM cards WHERE consumer_id = ? ORDER BY activated_at DESC').all(consumer.id);
    const transactions = db
      .prepare(
        `SELECT t.*, o.name AS operator_name FROM recharge_transactions t LEFT JOIN operators o ON o.id = t.operator_id
         WHERE t.consumer_id = ? ORDER BY t.id DESC`,
      )
      .all(consumer.id);
    res.json({ consumer, cards, transactions });
  });

  api.put('/consumers/:id', auth.requireAdmin, (req, res) => {
    const consumer = db.prepare('SELECT * FROM consumers WHERE id = ?').get(req.params.id);
    if (!consumer) throw notFound('Consumer not found');
    const input = validateConsumerInput(req.body, { partial: true });
    if (input.meter_number && input.meter_number !== consumer.meter_number) {
      const clash = db.prepare('SELECT name FROM consumers WHERE meter_number = ? AND id <> ?').get(input.meter_number, consumer.id);
      if (clash) throw badRequest(`Meter ${input.meter_number} is already registered to ${clash.name}`, { fields: { meterNumber: 'Already registered' } });
    }
    const merged = { ...consumer, ...input };
    db.prepare('UPDATE consumers SET name = ?, mobile = ?, address = ?, meter_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      merged.name,
      merged.mobile,
      merged.address,
      merged.meter_number,
      consumer.id,
    );
    res.json({ consumer: db.prepare('SELECT * FROM consumers WHERE id = ?').get(consumer.id) });
  });

  api.post('/cards/:uid/status', auth.requireAdmin, (req, res) => {
    const uid = req.params.uid.toUpperCase();
    const { status, note } = req.body;
    if (!['active', 'blocked', 'lost'].includes(status)) throw badRequest('Status must be active, blocked or lost');
    const card = db.prepare('SELECT * FROM cards WHERE card_uid = ?').get(uid);
    if (!card) throw notFound('Card not found');
    if (status === 'active' && card.status !== 'active') {
      const other = db.prepare("SELECT card_uid FROM cards WHERE consumer_id = ? AND status = 'active' AND card_uid <> ?").get(card.consumer_id, uid);
      if (other) throw conflict('HAS_ACTIVE_CARD', `This consumer already has an active card (${other.card_uid}). Block or mark that one lost first.`);
    }
    db.prepare('UPDATE cards SET status = ?, status_note = ?, status_changed_at = CURRENT_TIMESTAMP WHERE card_uid = ?').run(status, note ? String(note).slice(0, 200) : null, uid);
    res.json({ card: db.prepare('SELECT * FROM cards WHERE card_uid = ?').get(uid) });
  });

  // --- reports -----------------------------------------------------------------

  api.get('/reports', auth.requireAdmin, (req, res) => res.json({ reports: reports.listReports() }));
  api.get('/reports/:id', auth.requireAdmin, (req, res) => res.json(reports.runReport(db, req.params.id, req.query)));

  // --- operators ---------------------------------------------------------------

  const activeAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM operators WHERE role = 'admin' AND active = 1").get().n;

  api.get('/operators', auth.requireAdmin, (req, res) => {
    res.json({ operators: db.prepare('SELECT * FROM operators ORDER BY name COLLATE NOCASE').all().map(publicOperator) });
  });

  api.post('/operators', auth.requireAdmin, (req, res) => {
    const name = String(req.body.name || '').trim();
    const username = String(req.body.username || '').trim();
    const role = req.body.role === 'admin' ? 'admin' : 'operator';
    const fields = {};
    if (!name) fields.name = 'Required';
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) fields.username = '3-32 letters, digits, . _ -';
    const pwErr = validatePassword(req.body.password);
    if (pwErr) fields.password = pwErr;
    if (Object.keys(fields).length) throw badRequest('Please correct the highlighted fields', { fields });
    if (db.prepare('SELECT 1 FROM operators WHERE username = ?').get(username)) throw badRequest('Username already taken', { fields: { username: 'Taken' } });
    const id = db.prepare('INSERT INTO operators (name, username, password_hash, role) VALUES (?, ?, ?, ?)').run(name, username, hashPassword(req.body.password), role).lastInsertRowid;
    res.json({ operator: publicOperator(db.prepare('SELECT * FROM operators WHERE id = ?').get(id)) });
  });

  api.put('/operators/:id', auth.requireAdmin, (req, res) => {
    const op = db.prepare('SELECT * FROM operators WHERE id = ?').get(req.params.id);
    if (!op) throw notFound('Operator not found');
    const next = {
      name: req.body.name !== undefined ? String(req.body.name).trim() || op.name : op.name,
      role: req.body.role === 'admin' || req.body.role === 'operator' ? req.body.role : op.role,
      active: req.body.active !== undefined ? (req.body.active ? 1 : 0) : op.active,
    };
    const losesAdmin = op.role === 'admin' && op.active && (next.role !== 'admin' || !next.active);
    if (losesAdmin && activeAdmins() <= 1) throw badRequest('There must be at least one active admin');
    if (op.id === req.operator.id && !next.active) throw badRequest("You can't deactivate yourself");
    let hash = op.password_hash;
    if (req.body.password) {
      const err = validatePassword(req.body.password);
      if (err) throw badRequest(err, { fields: { password: err } });
      hash = hashPassword(req.body.password);
    }
    db.prepare('UPDATE operators SET name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?').run(next.name, next.role, next.active, hash, op.id);
    if (!next.active || req.body.password) db.prepare('DELETE FROM sessions WHERE operator_id = ? AND operator_id <> ?').run(op.id, req.operator.id);
    res.json({ operator: publicOperator(db.prepare('SELECT * FROM operators WHERE id = ?').get(op.id)) });
  });

  // --- settings ----------------------------------------------------------------

  api.get('/settings', auth.requireAdmin, (req, res) => res.json({ settings: getSettings(db) }));

  api.put('/settings', auth.requireAdmin, (req, res) => {
    const current = getSettings(db);
    const b = req.body;
    const money = (key, label, min, max) => {
      if (b[key] === undefined) return;
      if (!Number.isInteger(b[key]) || b[key] < min || b[key] > max) throw badRequest(`${label} must be between ₹${min / 100} and ₹${max / 100}`, { fields: { [key]: 'Out of range' } });
      setSetting(db, key, b[key]);
    };
    const update = db.transaction(() => {
      money('initialCreditPaise', 'Initial credit', 0, layout.UINT32_MAX);
      money('minRechargePaise', 'Minimum recharge', 100, layout.UINT32_MAX);
      money('maxRechargePaise', 'Maximum recharge', 100, layout.UINT32_MAX);
      const s = getSettings(db);
      if (s.minRechargePaise > s.maxRechargePaise) throw badRequest('Minimum recharge is above the maximum');
      if (b.tariff !== undefined) {
        const slabs = b.tariff && b.tariff.slabs;
        const changed = JSON.stringify(slabs) !== JSON.stringify(current.tariff.slabs);
        // The meter syncs the tariff from every card it reads; a new version
        // number makes the change visible in the meter's logs/dashboard.
        const tariff = { version: changed ? (current.tariff.version % 255) + 1 : current.tariff.version, slabs };
        const err = layout.validateTariff(tariff);
        if (err) throw badRequest(err, { fields: { tariff: err } });
        setSetting(db, 'tariff', tariff);
      }
    });
    update();
    res.json({ settings: getSettings(db) });
  });

  // --- mock reader controls (NFC_MOCK only) --------------------------------------

  if (reader.emulator) {
    const emu = reader.emulator;
    api.get('/dev/mock-cards', (req, res) => res.json({ cards: emu.listCards() }));
    api.post('/dev/mock-cards', (req, res) => {
      const uid = req.body.uid ? String(req.body.uid).replace(/[^0-9a-fA-F]/g, '') : undefined;
      res.json({ uid: emu.createCard(uid), cards: emu.listCards() });
    });
    api.post('/dev/mock-cards/:uid/tap', (req, res) => {
      emu.placeInField(req.params.uid);
      res.json({ cards: emu.listCards() });
    });
    api.post('/dev/mock-cards-remove', (req, res) => {
      emu.removeFromField();
      res.json({ cards: emu.listCards() });
    });
    api.post('/dev/mock-fault', (req, res) => {
      emu.injectWriteFault(Number(req.body.block));
      res.json({ ok: true });
    });
    api.delete('/dev/mock-cards/:uid', (req, res) => {
      emu.deleteCard(req.params.uid);
      res.json({ cards: emu.listCards() });
    });
  }

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such API endpoint' } }));

  // --- built frontend ----------------------------------------------------------

  if (fs.existsSync(config.clientDist)) {
    app.use(express.static(config.clientDist));
    app.get(/^\/(?!api|ws).*/, (req, res) => res.sendFile(path.join(config.clientDist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details || {}) } });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Invalid JSON body' } });
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error — see the server console' } });
  });

  return { app, attachWebSocket };
}

module.exports = { createApp };
