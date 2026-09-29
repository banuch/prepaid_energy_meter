// PN532 driver over HSU (high-speed UART), implemented directly on top of the
// frame protocol from the NXP PN532 User Manual (UM0701-02), §6.2.
//
// Why not an npm library: the existing PN532 packages (`pn532`, `nfc-pn532`)
// are unmaintained, pin ancient `serialport` majors that don't build on
// current Node, and only half-support MIFARE Classic auth/read/write. The
// protocol subset we need is small — 6 commands — so it lives here, isolated
// from business logic, with every frame logged (see nfc-log.js).
//
// The transport is anything with write(buf), on('data'|'error'|'close') and
// close() — a serialport SerialPort in production, pn532-emulator.js in mock
// mode and tests.

'use strict';

const { EventEmitter } = require('events');
const layout = require('./card-layout');
const log = require('./nfc-log');

const HOST_TO_PN532 = 0xd4;
const PN532_TO_HOST = 0xd5;
const ERROR_FRAME_TFI = 0x7f;

const CMD = {
  GET_FIRMWARE_VERSION: 0x02,
  SAM_CONFIGURATION: 0x14,
  RF_CONFIGURATION: 0x32,
  IN_DATA_EXCHANGE: 0x40,
  IN_LIST_PASSIVE_TARGET: 0x4a,
  IN_RELEASE: 0x52,
};

const MIFARE = {
  AUTH_A: 0x60,
  AUTH_B: 0x61,
  READ: 0x30,
  WRITE: 0xa0,
};

// PN532 status byte error codes we actually hit with MIFARE Classic (UM0701 §7.1).
const STATUS_ERRORS = {
  0x01: 'Timeout — card did not answer (moved away?)',
  0x02: 'CRC error — noisy RF link, hold the card steady',
  0x03: 'Parity error — noisy RF link, hold the card steady',
  0x13: 'Data format error',
  0x14: 'Authentication failed — wrong key for this sector',
  0x27: 'Command not valid in current context — card not selected',
  0x29: 'Card released/deselected',
};

const WAKEUP = Buffer.from([0x55, 0x55, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const ACK_FRAME = Buffer.from([0x00, 0x00, 0xff, 0x00, 0xff, 0x00]);

class Pn532Error extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'Pn532Error';
    this.code = code;
  }
}

function buildFrame(command, params = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from([HOST_TO_PN532, command]), params]);
  if (body.length > 254) throw new Error('Frame too long for a normal PN532 frame');
  const len = body.length;
  const lcs = (0x100 - len) & 0xff;
  let sum = 0;
  for (const b of body) sum += b;
  const dcs = (0x100 - (sum & 0xff)) & 0xff;
  return Buffer.concat([Buffer.from([0x00, 0x00, 0xff, len, lcs]), body, Buffer.from([dcs, 0x00])]);
}

// Pulls complete frames out of `buffer`. Returns { frames, rest }, where each
// frame is { type: 'ack'|'nack'|'data'|'error', body? }. Bytes before a start
// code are dropped (line noise, wakeup echoes, postambles).
function parseFrames(buffer) {
  const frames = [];
  let i = 0;
  while (i + 1 < buffer.length) {
    if (buffer[i] !== 0x00 || buffer[i + 1] !== 0xff) {
      i++;
      continue;
    }
    if (i + 3 >= buffer.length) break; // need LEN + LCS
    const len = buffer[i + 2];
    const lcs = buffer[i + 3];

    if (len === 0x00 && lcs === 0xff) {
      frames.push({ type: 'ack' });
      i += 4;
      continue;
    }
    if (len === 0xff && lcs === 0x00) {
      frames.push({ type: 'nack' });
      i += 4;
      continue;
    }
    if (((len + lcs) & 0xff) !== 0) {
      i++; // not really a start code — keep scanning
      continue;
    }
    const end = i + 4 + len + 1; // body + DCS
    if (end > buffer.length) break; // incomplete, wait for more bytes
    const body = buffer.subarray(i + 4, i + 4 + len);
    const dcs = buffer[i + 4 + len];
    let sum = dcs;
    for (const b of body) sum += b;
    if ((sum & 0xff) !== 0) {
      frames.push({ type: 'corrupt' });
    } else if (body[0] === ERROR_FRAME_TFI) {
      frames.push({ type: 'error', body });
    } else {
      frames.push({ type: 'data', body: Buffer.from(body) });
    }
    i = end;
  }
  return { frames, rest: buffer.subarray(i) };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class PN532 extends EventEmitter {
  constructor(transport, { commandTimeoutMs = 1000 } = {}) {
    super();
    this.transport = transport;
    this.commandTimeoutMs = commandTimeoutMs;
    this.rx = Buffer.alloc(0);
    this.pending = null;
    this.queue = Promise.resolve();
    this.closed = false;
    this.selectedTarget = null;

    transport.on('data', (chunk) => this._onData(chunk));
    transport.on('error', (err) => {
      log.error(`transport error: ${err.message}`);
      this._failPending(new Pn532Error(`Serial error: ${err.message}`, 'TRANSPORT'));
      this.emit('error', err);
    });
    transport.on('close', () => {
      this.closed = true;
      this._failPending(new Pn532Error('Serial port closed', 'TRANSPORT'));
      this.emit('close');
    });
  }

  static async openSerial(portPath, baudRate = 115200, options = {}) {
    const { SerialPort } = require('serialport');
    const port = await new Promise((resolve, reject) => {
      const p = new SerialPort({ path: portPath, baudRate, autoOpen: false });
      p.open((err) => (err ? reject(new Pn532Error(`Cannot open ${portPath}: ${err.message}`, 'TRANSPORT')) : resolve(p)));
    });
    log.op(`opened ${portPath} @ ${baudRate} baud`);
    return new PN532(port, options);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.transport.close();
    } catch {
      // already closed
    }
  }

  // --- framing ---------------------------------------------------------------

  _onData(chunk) {
    log.rx(chunk);
    this.rx = Buffer.concat([this.rx, chunk]);
    const { frames, rest } = parseFrames(this.rx);
    this.rx = Buffer.from(rest);
    for (const frame of frames) this._onFrame(frame);
  }

  _onFrame(frame) {
    const p = this.pending;
    if (!p) return; // unsolicited — ignore
    if (frame.type === 'ack') {
      p.acked = true;
      return;
    }
    if (frame.type === 'nack') return this._settle(new Pn532Error('PN532 sent NACK', 'NACK'));
    if (frame.type === 'corrupt') return this._settle(new Pn532Error('Corrupt frame from PN532 (checksum)', 'CHECKSUM'));
    if (frame.type === 'error') return this._settle(new Pn532Error('PN532 reported a syntax error frame', 'SYNTAX'));
    const { body } = frame;
    if (body[0] !== PN532_TO_HOST || body[1] !== p.command + 1) {
      return this._settle(new Pn532Error(`Unexpected response 0x${body[1]?.toString(16)} to command 0x${p.command.toString(16)}`, 'PROTOCOL'));
    }
    this._settle(null, body.subarray(2));
  }

  _settle(err, data) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(data);
  }

  _failPending(err) {
    if (this.pending) this._settle(err);
  }

  _write(buf) {
    log.tx(buf);
    return new Promise((resolve, reject) => {
      this.transport.write(buf, (err) => (err ? reject(new Pn532Error(`Serial write failed: ${err.message}`, 'TRANSPORT')) : resolve()));
    });
  }

  // Sends one command and resolves with the response payload (after the
  // command-code byte). Commands are strictly serialised.
  command(command, params = Buffer.alloc(0), timeoutMs = this.commandTimeoutMs) {
    const run = async () => {
      if (this.closed) throw new Pn532Error('Reader is not connected', 'TRANSPORT');
      const frame = buildFrame(command, params);
      const result = new Promise((resolve, reject) => {
        this.pending = {
          command,
          acked: false,
          resolve,
          reject,
          timer: setTimeout(() => {
            const acked = this.pending?.acked;
            this._settle(new Pn532Error(acked ? `PN532 timeout waiting for response to 0x${command.toString(16)}` : 'PN532 did not ACK — check wiring, baud rate and that the board is in HSU/UART mode', 'TIMEOUT'));
          }, timeoutMs),
        };
      });
      try {
        await this._write(frame);
      } catch (err) {
        this._settle(err);
      }
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  // --- device ----------------------------------------------------------------

  async wakeUp() {
    log.op('wakeup');
    await this._write(WAKEUP);
    await delay(50);
    this.rx = Buffer.alloc(0);
  }

  async getFirmwareVersion() {
    const r = await this.command(CMD.GET_FIRMWARE_VERSION);
    return { ic: r[0], version: r[1], revision: r[2], support: r[3], text: `PN5${r[0].toString(16)} v${r[1]}.${r[2]}` };
  }

  async samConfig() {
    // Normal mode, virtual-card timeout 1 s (0x14 x 50 ms), use IRQ.
    await this.command(CMD.SAM_CONFIGURATION, Buffer.from([0x01, 0x14, 0x01]));
  }

  // RFConfiguration item 5 (MaxRetries): with the default 0xFF,
  // InListPassiveTarget blocks forever when no card is in the field. A couple
  // of retries makes each poll return in a few ms either way.
  async setPassiveActivationRetries(retries) {
    await this.command(CMD.RF_CONFIGURATION, Buffer.from([0x05, 0xff, 0x01, retries]));
  }

  async init() {
    await this.wakeUp();
    await this.samConfig();
    const fw = await this.getFirmwareVersion();
    await this.setPassiveActivationRetries(0x02);
    log.op(`init ok: ${fw.text} (support 0x${fw.support.toString(16)})`);
    return fw;
  }

  // --- card ------------------------------------------------------------------

  // One ISO14443A poll. Resolves null when no card is in the field.
  async detectCard() {
    const r = await this.command(CMD.IN_LIST_PASSIVE_TARGET, Buffer.from([0x01, 0x00]));
    if (r[0] === 0) {
      this.selectedTarget = null;
      return null;
    }
    // Tg, SENS_RES (2), SEL_RES, NFCIDLength, NFCID...
    const atqa = r.readUInt16BE(2);
    const sak = r[4];
    const uidLength = r[5];
    const uid = Buffer.from(r.subarray(6, 6 + uidLength));
    this.selectedTarget = r[1];
    return { uid, uidHex: uid.toString('hex').toUpperCase(), atqa, sak, isMifareClassic: [0x08, 0x18, 0x09, 0x88].includes(sak) };
  }

  async _dataExchange(payload, what) {
    if (!this.selectedTarget) throw new Pn532Error('No card selected — tap the card again', 'NO_CARD');
    const r = await this.command(CMD.IN_DATA_EXCHANGE, Buffer.concat([Buffer.from([this.selectedTarget]), payload]));
    const status = r[0] & 0x3f;
    if (status !== 0) {
      const reason = STATUS_ERRORS[status] || `PN532 status 0x${status.toString(16)}`;
      // Any MIFARE error halts the card; it must be re-selected before the next command.
      this.selectedTarget = null;
      throw new Pn532Error(`${what}: ${reason}`, status === 0x14 ? 'AUTH' : 'CARD');
    }
    return r.subarray(1);
  }

  // Authenticates the sector that contains `block`. For 7-byte UIDs the
  // MIFARE auth uses the last 4 UID bytes (same as libnfc).
  async authenticateBlock(block, uid, key = layout.KEY_A, keyType = 'A') {
    const uid4 = uid.subarray(uid.length - 4);
    const payload = Buffer.concat([Buffer.from([keyType === 'B' ? MIFARE.AUTH_B : MIFARE.AUTH_A, block]), key, uid4]);
    await this._dataExchange(payload, `auth sector ${layout.sectorOf(block)} (block ${block})`);
    log.op(`auth key${keyType} sector ${layout.sectorOf(block)} ok (uid ${uid.toString('hex')})`);
  }

  async readBlock(block) {
    const data = await this._dataExchange(Buffer.from([MIFARE.READ, block]), `read block ${block}`);
    if (data.length !== 16) throw new Pn532Error(`read block ${block}: got ${data.length} bytes, expected 16`, 'CARD');
    log.op(`read block ${block}: ${data.toString('hex')}`);
    return Buffer.from(data);
  }

  async writeBlock(block, data) {
    if (layout.isTrailerBlock(block) || layout.isManufacturerBlock(block)) {
      // A bad trailer write permanently locks the sector. This app never needs it.
      throw new Pn532Error(`Refusing to write block ${block} (sector trailer / manufacturer block)`, 'FORBIDDEN');
    }
    if (!Buffer.isBuffer(data) || data.length !== 16) throw new Pn532Error('Block data must be 16 bytes', 'ARGUMENT');
    log.op(`write block ${block}: ${data.toString('hex')}`);
    await this._dataExchange(Buffer.concat([Buffer.from([MIFARE.WRITE, block]), data]), `write block ${block}`);
  }

  async release() {
    if (!this.selectedTarget) return;
    const target = this.selectedTarget;
    this.selectedTarget = null;
    try {
      await this.command(CMD.IN_RELEASE, Buffer.from([target]));
    } catch {
      // best effort
    }
  }
}

module.exports = { PN532, Pn532Error, buildFrame, parseFrames, CMD, MIFARE, ACK_FRAME };
