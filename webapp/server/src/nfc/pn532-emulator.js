// Software PN532 + MIFARE Classic 1K cards, speaking the real HSU frame
// protocol. Used when NFC_MOCK=1 (desk development without hardware) and by
// the self-tests, so pn532.js is exercised byte-for-byte either way.
//
// Behaves like the real thing where it matters to the app: Key A auth per
// sector, a failed auth or a missing card halts the card (must be re-selected),
// trailer/manufacturer blocks are protected, and a one-shot write fault can
// be injected to test the half-written-card paths.

'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseFrames, CMD, MIFARE } = require('./pn532');

const TRAILER = Buffer.from('ffffffffffffff078069ffffffffffff', 'hex');

function frame(body) {
  const len = body.length;
  let sum = 0;
  for (const b of body) sum += b;
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0xff, len, (0x100 - len) & 0xff]),
    body,
    Buffer.from([(0x100 - (sum & 0xff)) & 0xff, 0x00]),
  ]);
}

const ACK = Buffer.from([0x00, 0x00, 0xff, 0x00, 0xff, 0x00]);

function blankCard(uid) {
  const blocks = [];
  for (let b = 0; b < 64; b++) blocks.push(Buffer.alloc(16));
  const bcc = uid.reduce((x, y) => x ^ y, 0);
  Buffer.concat([uid, Buffer.from([bcc, 0x08, 0x04, 0x00]), Buffer.from('62636465666768696a', 'hex')]).copy(blocks[0]);
  for (let b = 3; b < 64; b += 4) TRAILER.copy(blocks[b]);
  return { uid, blocks };
}

class Pn532Emulator extends EventEmitter {
  constructor({ storeFile = null, responseDelayMs = 3 } = {}) {
    super();
    this.storeFile = storeFile;
    this.responseDelayMs = responseDelayMs;
    this.cards = new Map(); // uidHex -> { uid, blocks }
    this.fieldUid = null;
    this.selected = false;
    this.authSector = null;
    this.rx = Buffer.alloc(0);
    this.fault = null; // { block } — next write to that block fails
    this.open = true;
    this._load();
  }

  // --- transport interface (what pn532.js expects of a SerialPort) ------------

  write(buf, cb) {
    if (!this.open) {
      cb && cb(new Error('port closed'));
      return;
    }
    this.rx = Buffer.concat([this.rx, buf]);
    const { frames, rest } = parseFrames(this.rx);
    this.rx = Buffer.from(rest);
    cb && cb(null);
    for (const f of frames) {
      if (f.type !== 'data') continue;
      setTimeout(() => {
        this.emit('data', ACK);
        const response = this._handle(f.body);
        if (response) setTimeout(() => this.emit('data', frame(response)), this.responseDelayMs);
      }, this.responseDelayMs);
    }
  }

  close() {
    this.open = false;
    this.emit('close');
  }

  // --- control (dev API / tests) ---------------------------------------------

  createCard(uidHex) {
    const uid = uidHex ? Buffer.from(uidHex, 'hex') : crypto.randomBytes(4);
    if (uid.length !== 4 && uid.length !== 7) throw new Error('UID must be 4 or 7 bytes');
    const key = uid.toString('hex').toUpperCase();
    if (!this.cards.has(key)) this.cards.set(key, blankCard(uid));
    this._save();
    return key;
  }

  deleteCard(uidHex) {
    const key = uidHex.toUpperCase();
    if (this.fieldUid === key) this.removeFromField();
    this.cards.delete(key);
    this._save();
  }

  placeInField(uidHex) {
    const key = uidHex.toUpperCase();
    if (!this.cards.has(key)) throw new Error(`No mock card ${key}`);
    this.fieldUid = key;
    this.selected = false;
    this.authSector = null;
  }

  removeFromField() {
    this.fieldUid = null;
    this.selected = false;
    this.authSector = null;
  }

  injectWriteFault(block) {
    this.fault = { block };
  }

  listCards() {
    return [...this.cards.values()].map((c) => ({
      uid: c.uid.toString('hex').toUpperCase(),
      inField: this.fieldUid === c.uid.toString('hex').toUpperCase(),
      blocks: Object.fromEntries([4, 5, 6, 8, 9, 10].map((b) => [b, c.blocks[b].toString('hex')])),
    }));
  }

  // --- PN532 command handling ------------------------------------------------

  _handle(body) {
    if (body[0] !== 0xd4) return null;
    const cmd = body[1];
    const params = body.subarray(2);
    const reply = (...bytes) => Buffer.from([0xd5, cmd + 1, ...bytes]);

    switch (cmd) {
      case CMD.GET_FIRMWARE_VERSION:
        return reply(0x32, 0x01, 0x06, 0x07);
      case CMD.SAM_CONFIGURATION:
      case CMD.RF_CONFIGURATION:
        return reply();
      case CMD.IN_RELEASE:
        this.selected = false;
        this.authSector = null;
        return reply(0x00);
      case CMD.IN_LIST_PASSIVE_TARGET: {
        const card = this.fieldUid && this.cards.get(this.fieldUid);
        if (!card) return reply(0x00);
        this.selected = true;
        this.authSector = null;
        return reply(0x01, 0x01, 0x00, 0x04, 0x08, card.uid.length, ...card.uid);
      }
      case CMD.IN_DATA_EXCHANGE:
        return reply(...this._dataExchange(params.subarray(1)));
      default:
        return Buffer.from([0x7f]); // syntax error frame
    }
  }

  _fail(status) {
    this.selected = false;
    this.authSector = null;
    return [status];
  }

  _dataExchange(p) {
    const card = this.fieldUid && this.cards.get(this.fieldUid);
    if (!card) return this._fail(0x01); // card gone: timeout
    if (!this.selected) return this._fail(0x27);

    const op = p[0];
    const block = p[1];
    if (block >= 64) return this._fail(0x14);
    const sector = Math.floor(block / 4);

    if (op === MIFARE.AUTH_A || op === MIFARE.AUTH_B) {
      const key = p.subarray(2, 8);
      const uid4 = p.subarray(8, 12);
      const trailer = card.blocks[sector * 4 + 3];
      const expected = op === MIFARE.AUTH_A ? trailer.subarray(0, 6) : trailer.subarray(10, 16);
      if (!key.equals(expected) || !uid4.equals(card.uid.subarray(card.uid.length - 4))) return this._fail(0x14);
      this.authSector = sector;
      return [0x00];
    }

    if (this.authSector !== sector) return this._fail(0x14);

    if (op === MIFARE.READ) {
      const data = Buffer.from(card.blocks[block]);
      if (block % 4 === 3) data.fill(0, 0, 6); // key A never reads back
      return [0x00, ...data];
    }

    if (op === MIFARE.WRITE) {
      if (block === 0 || block % 4 === 3) return this._fail(0x14);
      if (this.fault && this.fault.block === block) {
        this.fault = null;
        return this._fail(0x01);
      }
      Buffer.from(p.subarray(2, 18)).copy(card.blocks[block]);
      this._save();
      return [0x00];
    }

    return this._fail(0x13);
  }

  // --- persistence -----------------------------------------------------------

  _load() {
    if (!this.storeFile || !fs.existsSync(this.storeFile)) return;
    const data = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
    for (const [uidHex, blocks] of Object.entries(data)) {
      this.cards.set(uidHex, { uid: Buffer.from(uidHex, 'hex'), blocks: blocks.map((h) => Buffer.from(h, 'hex')) });
    }
  }

  _save() {
    if (!this.storeFile) return;
    fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
    const data = {};
    for (const [uidHex, card] of this.cards) data[uidHex] = card.blocks.map((b) => b.toString('hex'));
    fs.writeFileSync(this.storeFile, JSON.stringify(data, null, 1));
  }
}

module.exports = { Pn532Emulator };
