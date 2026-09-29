'use strict';

const test = require('node:test');
const assert = require('node:assert');
const layout = require('../src/nfc/card-layout');
const { PN532, buildFrame, parseFrames } = require('../src/nfc/pn532');
const { Pn532Emulator } = require('../src/nfc/pn532-emulator');
const cardService = require('../src/nfc/card-service');

test('frames match the PN532 user manual', () => {
  // UM0701 example: GetFirmwareVersion
  assert.strictEqual(buildFrame(0x02).toString('hex'), '0000ff02fed4022a00');
  const { frames } = parseFrames(Buffer.from('0000ff00ff00' + '0000ff06fad50332010607e800', 'hex'));
  assert.deepStrictEqual(frames.map((f) => f.type), ['ack', 'data']);
  assert.strictEqual(frames[1].body.toString('hex'), 'd503320106 07'.replace(/ /g, ''));
});

test('parser survives noise and split chunks', () => {
  const full = Buffer.from('55550000ff00ff000000ff06fad50332010607e800', 'hex');
  const a = parseFrames(full.subarray(0, 9));
  const b = parseFrames(Buffer.concat([a.rest, full.subarray(9)]));
  assert.deepStrictEqual([...a.frames, ...b.frames].map((f) => f.type), ['ack', 'data']);
});

test('block encodings are byte-compatible with the firmware', () => {
  // firmware: readUint32BE(amountData, 0)
  assert.strictEqual(layout.encodeAmount(123456).toString('hex'), '0001e240000000000000000000000000');
  const prev = Buffer.from('00000003000003e8060900000011abcd', 'hex');
  const meta = layout.encodeMeta({ counter: 4, lastAmountPaise: 50000 }, prev);
  // counter + last amount replaced; cycle year/month/units + reserved kept
  assert.strictEqual(meta.toString('hex'), '000000040000c350060900000011abcd');
  assert.deepStrictEqual(
    { ...layout.decodeMeta(meta), reserved: undefined },
    { counter: 4, lastAmountPaise: 50000, cycleYear: 2026, cycleMonth: 9, cycleUnitsConsumed: 17, reserved: undefined },
  );
  assert.strictEqual(layout.decodeServiceNumber(layout.encodeServiceNumber('MTR-0042')), 'MTR-0042');
  assert.throws(() => layout.encodeServiceNumber('X'.repeat(17)));

  const tariff = { version: 3, slabs: [{ upperLimitUnits: 50, ratePaisePerUnit: 265 }, { upperLimitUnits: null, ratePaisePerUnit: 995 }] };
  const t = layout.encodeTariff(tariff);
  assert.strictEqual(t[8].toString('hex').slice(0, 4), '0302');
  assert.strictEqual(t[9].toString('hex').slice(0, 16), '00320109ffff03e3');
  assert.deepStrictEqual(layout.decodeTariff(t[8], t[9], t[10]), tariff);
  assert.match(layout.validateTariff({ version: 1, slabs: [{ upperLimitUnits: null, ratePaisePerUnit: 1 }, { upperLimitUnits: 5, ratePaisePerUnit: 1 }] }), /only the last/);
});

async function rig() {
  const emu = new Pn532Emulator({ responseDelayMs: 0 });
  const pn = new PN532(emu);
  await pn.init();
  return { emu, pn };
}

const TARIFF = { version: 1, slabs: [{ upperLimitUnits: null, ratePaisePerUnit: 500 }] };

test('driver: no card, auth with wrong key, trailer protection', async () => {
  const { emu, pn } = await rig();
  assert.strictEqual(await pn.detectCard(), null);
  const uid = emu.createCard('A1B2C3D4');
  emu.placeInField(uid);
  const target = await pn.detectCard();
  assert.strictEqual(target.uidHex, 'A1B2C3D4');
  await assert.rejects(pn.authenticateBlock(4, target.uid, Buffer.alloc(6)), { code: 'AUTH' });
  // a failed auth halts the card until it is re-selected
  await assert.rejects(pn.readBlock(4), { code: 'NO_CARD' });
  await pn.detectCard();
  await pn.authenticateBlock(4, target.uid);
  await assert.rejects(pn.writeBlock(7, Buffer.alloc(16)), { code: 'FORBIDDEN' });
  await assert.rejects(pn.readBlock(8), { code: 'AUTH' }); // sector 2 not authenticated
});

test('recharge write: committed / not committed / changed card', async () => {
  const { emu, pn } = await rig();
  emu.placeInField(emu.createCard('01020304'));

  let r = await cardService.writeRecharge(pn, { expectedUid: '01020304', expectedCounter: 0, amountPaise: 10000, counter: 1, serviceNumber: 'M1', tariff: TARIFF });
  assert.strictEqual(r.committed, 'yes');
  assert.strictEqual(r.card.counter, 1);
  assert.strictEqual(r.card.amountPaise, 10000);

  // fault before the counter block: nothing credited
  emu.injectWriteFault(layout.AMOUNT_BLOCK);
  r = await cardService.writeRecharge(pn, { expectedUid: '01020304', expectedCounter: 1, amountPaise: 20000, counter: 2, serviceNumber: 'M1', tariff: TARIFF });
  assert.strictEqual(r.committed, 'no');
  const after = await cardService.readCard(pn);
  assert.strictEqual(after.counter, 1);

  // fault ON the counter block, card still readable: verifiably not committed
  emu.injectWriteFault(layout.META_BLOCK);
  r = await cardService.writeRecharge(pn, { expectedUid: '01020304', expectedCounter: 1, amountPaise: 20000, counter: 2, serviceNumber: 'M1', tariff: TARIFF });
  assert.strictEqual(r.committed, 'no');

  // card removed right at the counter write: unknown
  emu.injectWriteFault(layout.META_BLOCK);
  const origWrite = emu._dataExchange.bind(emu);
  emu._dataExchange = (p) => {
    const res = origWrite(p);
    if (p[0] === 0xa0 && p[1] === layout.META_BLOCK) emu.removeFromField();
    return res;
  };
  r = await cardService.writeRecharge(pn, { expectedUid: '01020304', expectedCounter: 1, amountPaise: 20000, counter: 2, serviceNumber: 'M1', tariff: TARIFF });
  assert.strictEqual(r.committed, 'unknown');

  emu._dataExchange = origWrite;
  emu.placeInField('01020304');
  await assert.rejects(
    cardService.writeRecharge(pn, { expectedUid: '01020304', expectedCounter: 7, amountPaise: 1, counter: 8, serviceNumber: 'M1', tariff: TARIFF }),
    { code: 'CHANGED' },
  );
  await assert.rejects(
    cardService.writeRecharge(pn, { expectedUid: 'FFFFFFFF', expectedCounter: 1, amountPaise: 1, counter: 2, serviceNumber: 'M1', tariff: TARIFF }),
    { code: 'WRONG_CARD' },
  );
});
