// Owns the PN532: connects (and reconnects), polls for card taps, and gives
// callers exclusive access for multi-step operations so a poll can never
// interleave with a half-done write.
//
// Events:
//   'status'  reader status changed (see status())
//   'card'    { uid, card, error }  — a card arrived and was read (or failed)
//   'removed' { uid }              — the card left the field

'use strict';

const { EventEmitter } = require('events');
const { PN532 } = require('./pn532');
const { Pn532Emulator } = require('./pn532-emulator');
const cardService = require('./card-service');
const log = require('./nfc-log');

// VIDs of the usual USB-UART bridges on PN532 boards: CH340, CP210x, FTDI, PL2303.
const USB_UART_VIDS = ['1a86', '10c4', '0403', '067b'];

class Reader extends EventEmitter {
  constructor({ port = 'auto', baudRate = 115200, mock = false, mockStore = null, pollIntervalMs = 300 }) {
    super();
    this.opts = { port, baudRate, mock, pollIntervalMs };
    this.emulator = mock ? new Pn532Emulator({ storeFile: mockStore }) : null;
    this.pn = null;
    this.state = { connected: false, portPath: null, firmware: null, error: null };
    this.presentUid = null;
    this.lastCard = null;
    this.lock = Promise.resolve();
    this.locked = false;
    this.timer = null;
    this.stopped = true;
  }

  status() {
    return {
      mode: this.opts.mock ? 'mock' : 'serial',
      connected: this.state.connected,
      port: this.state.portPath,
      firmware: this.state.firmware,
      error: this.state.error,
      cardPresent: !!this.presentUid,
      cardUid: this.presentUid,
    };
  }

  start() {
    this.stopped = false;
    this._schedule(0);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.pn) this.pn.close();
  }

  _setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('status', this.status());
  }

  _schedule(ms) {
    clearTimeout(this.timer);
    if (!this.stopped) this.timer = setTimeout(() => this._tick(), ms);
  }

  async _tick() {
    if (!this.pn) {
      const ok = await this._connect();
      return this._schedule(ok ? this.opts.pollIntervalMs : 3000);
    }
    if (!this.locked) {
      await this.exclusive((pn) => this._poll(pn)).catch(() => {});
    }
    this._schedule(this.opts.pollIntervalMs);
  }

  async _candidatePorts() {
    if (this.opts.port !== 'auto') return [this.opts.port];
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    const usb = ports.filter((p) => p.vendorId && USB_UART_VIDS.includes(p.vendorId.toLowerCase()));
    const others = ports.filter((p) => !usb.includes(p));
    return [...usb, ...others].map((p) => p.path);
  }

  async _connect() {
    if (this.emulator) {
      if (!this.emulator.open) this.emulator = new Pn532Emulator({ storeFile: this.emulator.storeFile });
      const error = await this._attach(new PN532(this.emulator), 'mock');
      if (error) this._setState({ connected: false, error: error.message });
      return !error;
    }
    let candidates;
    try {
      candidates = await this._candidatePorts();
    } catch (err) {
      this._setState({ connected: false, error: `Cannot list serial ports: ${err.message}` });
      return false;
    }
    if (!candidates.length) {
      this._setState({ connected: false, portPath: null, error: 'No serial ports found — is the PN532 USB adapter plugged in?' });
      return false;
    }
    let lastError = null;
    for (const portPath of candidates) {
      let pn;
      try {
        pn = await PN532.openSerial(portPath, this.opts.baudRate);
      } catch (err) {
        lastError = err;
        continue;
      }
      const attachError = await this._attach(pn, portPath);
      if (!attachError) return true;
      lastError = attachError;
    }
    const tried = candidates.join(', ');
    this._setState({ connected: false, portPath: null, error: `No PN532 found (tried ${tried}): ${lastError ? lastError.message : 'no answer'}` });
    return false;
  }

  // Resolves null when the PN532 answered, else the Error.
  async _attach(pn, portPath) {
    try {
      const fw = await pn.init();
      pn.on('close', () => this._onDisconnect('Reader disconnected (serial port closed)'));
      pn.on('error', () => {});
      this.pn = pn;
      this._setState({ connected: true, portPath, firmware: fw.text, error: null });
      log.op(`reader connected on ${portPath}: ${fw.text}`);
      return null;
    } catch (err) {
      pn.close();
      log.error(`${portPath}: ${err.message}`);
      return new Error(`${portPath}: ${err.message}`);
    }
  }

  _onDisconnect(reason) {
    if (!this.pn) return;
    this.pn = null;
    log.error(reason);
    if (this.presentUid) {
      const uid = this.presentUid;
      this.presentUid = null;
      this.emit('removed', { uid });
    }
    this._setState({ connected: false, error: reason });
  }

  async _poll(pn) {
    let target;
    try {
      target = await pn.detectCard();
    } catch (err) {
      if (err.code === 'TRANSPORT' || err.code === 'TIMEOUT') {
        pn.close();
        this._onDisconnect(`Reader stopped responding: ${err.message}`);
      }
      return;
    }
    if (!target) {
      if (this.presentUid) {
        const uid = this.presentUid;
        this.presentUid = null;
        this.lastCard = null;
        log.op(`card ${uid} removed`);
        this.emit('removed', { uid });
        this.emit('status', this.status());
      }
      return;
    }
    if (target.uidHex === this.presentUid) return; // same card still resting on the reader

    this.presentUid = target.uidHex;
    log.op(`card ${target.uidHex} detected (SAK 0x${target.sak.toString(16)})`);
    this.emit('status', this.status());
    await this._readAndEmit(pn, target.uidHex);
  }

  async _readAndEmit(pn, uid) {
    try {
      const card = await cardService.readCard(pn, uid);
      this.lastCard = card;
      this.emit('card', { uid, card, error: null });
    } catch (err) {
      this.lastCard = null;
      log.error(`read ${uid} failed: ${err.message}`);
      this.emit('card', { uid, card: null, error: err.message });
    }
  }

  // Runs fn(pn) with the reader to itself.
  exclusive(fn) {
    const run = async () => {
      if (!this.pn) throw Object.assign(new Error(this.state.error || 'Reader is not connected'), { code: 'NO_READER' });
      this.locked = true;
      try {
        return await fn(this.pn);
      } finally {
        this.locked = false;
      }
    };
    const next = this.lock.then(run, run);
    this.lock = next.catch(() => {});
    return next;
  }

  // Re-reads whatever card is on the reader right now and emits it as a tap.
  async rereadCard() {
    return this.exclusive(async (pn) => {
      const target = await pn.detectCard();
      if (!target) {
        this.presentUid = null;
        throw Object.assign(new Error('No card on the reader'), { code: 'NO_CARD' });
      }
      this.presentUid = target.uidHex;
      await this._readAndEmit(pn, target.uidHex);
      return this.lastCard;
    });
  }
}

module.exports = { Reader };
