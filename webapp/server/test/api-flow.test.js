'use strict';

// End-to-end through HTTP + WebSocket with the emulated reader:
// register -> recharge -> inquiry -> replacement card -> reports -> roles.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const { open } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { Reader } = require('../src/nfc/reader');
const { createApp } = require('../src/app');

const once = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-test-'));
  const db = open(path.join(dir, 'test.db'));
  db.prepare("INSERT INTO operators (name, username, password_hash, role) VALUES ('Admin', 'admin', ?, 'admin')").run(hashPassword('admin-pass-1'));
  db.prepare("INSERT INTO operators (name, username, password_hash, role) VALUES ('Op', 'op', ?, 'operator')").run(hashPassword('op-pass-123'));
  const reader = new Reader({ mock: true, pollIntervalMs: 20 });
  reader.emulator.responseDelayMs = 0;
  const { app, attachWebSocket } = createApp({ db, reader, config: { sessionHours: 1, clientDist: path.join(dir, 'none') } });
  const server = http.createServer(app);
  attachWebSocket(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const connected = once(reader, 'status');
  reader.start();
  await connected;

  const client = async (username, password) => {
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.strictEqual(res.status, 200);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const call = async (method, url, body) => {
      const r = await fetch(`${base}/api${url}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    return { cookie, get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b) };
  };

  // Tap = put a mock card in the field and wait for the reader's 'card' event.
  const tap = async (uid) => {
    reader.emulator.removeFromField();
    await new Promise((r) => setTimeout(r, 60));
    const ev = once(reader, 'card');
    reader.emulator.placeInField(uid);
    await ev;
    await new Promise((r) => setImmediate(r));
  };

  return {
    db,
    reader,
    base,
    client,
    tap,
    close: () => {
      reader.stop();
      server.closeAllConnections();
      server.close();
      db.close();
    },
  };
}

test('full desk flow', async (t) => {
  const s = await setup();
  t.after(() => s.close());
  const admin = await s.client('admin', 'admin-pass-1');
  const op = await s.client('op', 'op-pass-123');

  // unauthenticated
  assert.strictEqual((await fetch(`${s.base}/api/status`)).status, 401);

  // websocket gets tap events
  const ws = new WebSocket(`${s.base.replace('http', 'ws')}/ws`, { headers: { cookie: op.cookie } });
  const messages = [];
  ws.on('message', (m) => messages.push(JSON.parse(m)));
  await once(ws, 'open');
  t.after(() => ws.close());

  // --- Phase 2: register a new consumer on a blank card ---
  const uid1 = s.reader.emulator.createCard('11223344');
  await s.tap(uid1);
  let tap = (await op.get('/cards/current')).body.tap;
  assert.strictEqual(tap.uid, '11223344');
  assert.strictEqual(tap.record.known, false);
  assert.strictEqual(tap.card.blank, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(messages.some((m) => m.type === 'card' && m.uid === '11223344'), 'card tap pushed over websocket');

  let r = await op.post('/cards/issue', {
    uid: uid1,
    expectedCounter: 0,
    paymentMode: 'cash',
    consumer: { name: 'Ravi Kumar', mobile: '+91 98480 12345', address: 'H.No 1-2, Hyderabad', meterNumber: 'tg-mtr-001' },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.committed, 'yes');
  assert.strictEqual(r.body.transaction.status, 'completed');
  assert.strictEqual(r.body.transaction.amount, 10000);
  assert.strictEqual(r.body.card.counter, 1);
  assert.strictEqual(r.body.card.serviceNumber, 'TG-MTR-001');
  assert.strictEqual(r.body.card.tariff.slabs.length, 7);
  assert.strictEqual(r.body.consumer.mobile, '9848012345');
  const consumerId = r.body.consumer.id;

  // same card again -> already registered
  r = await op.post('/cards/issue', { uid: uid1, expectedCounter: 1, consumer: { name: 'X', mobile: '9848012346', meterNumber: 'M2' } });
  assert.strictEqual(r.body.error.code, 'CARD_REGISTERED');

  // duplicate meter number on another card
  const uidX = s.reader.emulator.createCard('55667788');
  await s.tap(uidX);
  r = await op.post('/cards/issue', { uid: uidX, expectedCounter: 0, consumer: { name: 'Y', mobile: '9848012347', meterNumber: 'TG-MTR-001' } });
  assert.strictEqual(r.status, 400);
  assert.ok(r.body.error.fields.meterNumber);

  // --- Phase 3: recharge ---
  await s.tap(uid1);
  tap = (await op.get('/cards/current')).body.tap;
  assert.strictEqual(tap.record.known, true);
  assert.strictEqual(tap.record.consumer.name, 'Ravi Kumar');
  assert.strictEqual(tap.record.needsMeterTapConfirmation, true);

  r = await op.post('/cards/recharge', { uid: uid1, expectedCounter: 1, amountPaise: 50000, paymentMode: 'upi' });
  assert.strictEqual(r.body.error.code, 'CONFIRM_METER_TAPPED');
  r = await op.post('/cards/recharge', { uid: uid1, expectedCounter: 0, amountPaise: 50000, paymentMode: 'upi', confirmMeterTapped: true });
  assert.strictEqual(r.body.error.code, 'CARD_CHANGED');
  r = await op.post('/cards/recharge', { uid: uid1, expectedCounter: 1, amountPaise: 50, paymentMode: 'upi', confirmMeterTapped: true });
  assert.strictEqual(r.status, 400);
  r = await op.post('/cards/recharge', { uid: uid1, expectedCounter: 1, amountPaise: 50000, paymentMode: 'upi', paymentRef: 'UPI123', confirmMeterTapped: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.card.amountPaise, 50000);
  assert.strictEqual(r.body.card.counter, 2);
  assert.strictEqual(r.body.card.lastAmountPaise, 50000);
  assert.match(r.body.transaction.receipt_no, /^R\d{6}-\d{5}$/);

  // raw bytes on the card exactly as the firmware reads them
  const raw = s.reader.emulator.listCards().find((c) => c.uid === uid1).blocks;
  assert.strictEqual(raw[4], '0000c350000000000000000000000000');
  assert.strictEqual(raw[5].slice(0, 16), '000000020000c350');

  // failed write (fault before commit): recorded as failed, 502, no credit
  s.reader.emulator.injectWriteFault(4);
  r = await op.post('/cards/recharge', { uid: uid1, expectedCounter: 2, amountPaise: 20000, paymentMode: 'cash', confirmMeterTapped: true });
  assert.strictEqual(r.status, 502);
  assert.strictEqual(r.body.error.code, 'WRITE_FAILED');
  // retry works and uses a fresh counter (3 was claimed, so 4)
  r = await op.post('/cards/recharge', { uid: uid1, expectedCounter: 2, amountPaise: 20000, paymentMode: 'cash', confirmMeterTapped: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.card.counter, 4);

  // unknown card -> can't recharge
  r = await op.post('/cards/recharge', { uid: 'DEADBEEF', expectedCounter: 0, amountPaise: 20000, paymentMode: 'cash' });
  assert.strictEqual(r.body.error.code, 'UNKNOWN_CARD');

  // --- replacement card continues the meter's counter ---
  const uid2 = s.reader.emulator.createCard('99AABBCC');
  await s.tap(uid2);
  r = await op.post('/cards/issue', { uid: uid2, expectedCounter: 0, consumerId, paymentMode: 'free' });
  assert.strictEqual(r.body.error.code, 'HAS_ACTIVE_CARD');
  r = await op.post('/cards/issue', { uid: uid2, expectedCounter: 0, consumerId, paymentMode: 'free', replaceActiveCards: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.card.counter, 5, 'replacement card continues from the meter counter');

  // old card now lost and refused
  await s.tap(uid1);
  tap = (await op.get('/cards/current')).body.tap;
  assert.strictEqual(tap.record.canRecharge, false);
  r = await op.post('/cards/recharge', { uid: uid1, expectedCounter: 4, amountPaise: 20000, paymentMode: 'cash', confirmMeterTapped: true });
  assert.strictEqual(r.body.error.code, 'CARD_INACTIVE');

  // --- Phase 5/7: roles ---
  assert.strictEqual((await op.get(`/consumers/${consumerId}`)).status, 403);
  assert.strictEqual((await op.get('/reports/recharge-history')).status, 403);
  assert.strictEqual((await op.get('/consumers?q=ravi')).body.total, 1);
  const detail = (await admin.get(`/consumers/${consumerId}`)).body;
  assert.strictEqual(detail.cards.length, 2);
  assert.deepStrictEqual(detail.transactions.map((x) => x.status), ['completed', 'completed', 'failed', 'completed', 'completed']);

  r = await admin.post(`/cards/${uid1}/status`, { status: 'active' });
  assert.strictEqual(r.body.error.code, 'HAS_ACTIVE_CARD');
  r = await admin.post(`/cards/${uid2}/status`, { status: 'blocked', note: 'test' });
  assert.strictEqual(r.body.card.status, 'blocked');

  // --- Phase 6: reports ---
  const today = new Date().toLocaleDateString('en-CA');
  const collection = (await admin.get(`/reports/payment-collection?from=${today}&to=${today}`)).body;
  assert.strictEqual(collection.totals.amount, 10000 + 50000 + 20000, 'free replacement credit and failed write excluded');
  const daily = (await admin.get('/reports/collection-summary?period=daily')).body;
  assert.strictEqual(daily.rows[0].period, today);
  assert.strictEqual(daily.rows[0].upi, 50000);
  for (const { id } of (await admin.get('/reports')).body.reports) {
    const rep = await admin.get(`/reports/${id}`);
    assert.strictEqual(rep.status, 200, `${id}: ${JSON.stringify(rep.body)}`);
  }
  const notSeen = (await admin.get('/reports/cards-not-seen?days=0')).body;
  assert.match(notSeen.note, /last time each active card was tapped at this desk/);
});

test('an unconfirmed write is resolved on the next tap', async (t) => {
  const s = await setup();
  t.after(() => s.close());
  const op = await s.client('op', 'op-pass-123');
  const emu = s.reader.emulator;
  const uid = emu.createCard('0A0B0C0D');
  await s.tap(uid);
  await op.post('/cards/issue', { uid, expectedCounter: 0, consumer: { name: 'Sita', mobile: '9000000001', meterNumber: 'M-9' } });

  // card yanked right after the counter block write -> uncertain
  const orig = emu._dataExchange.bind(emu);
  emu._dataExchange = (p) => {
    const res = orig(p);
    if (p[0] === 0xa0 && p[1] === 5) emu.removeFromField();
    return res;
  };
  const r = await op.post('/cards/recharge', { uid, expectedCounter: 1, amountPaise: 30000, paymentMode: 'cash', confirmMeterTapped: true });
  emu._dataExchange = orig;
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.committed, 'unknown');
  assert.strictEqual(r.body.transaction.status, 'uncertain');

  await s.tap(uid);
  const row = s.db.prepare('SELECT status FROM recharge_transactions WHERE id = ?').get(r.body.transaction.id);
  assert.strictEqual(row.status, 'completed', 'write had landed, so the re-tap confirms it');
});
