#!/usr/bin/env node
// Phase 1 bench test for the desk PN532 — no web UI, no database.
//
//   node scripts/nfc-test.js ports                      list serial ports
//   node scripts/nfc-test.js info      [--port COM5]    PN532 firmware version
//   node scripts/nfc-test.js wait      [--port COM5]    wait for a card, print UID
//   node scripts/nfc-test.js dump      [--port COM5]    read + decode the prepaid blocks (4-6, 8-10)
//   node scripts/nfc-test.js read  <block>              read one raw block
//   node scripts/nfc-test.js write <block> <32 hex chars> --yes
//                                                       write one raw block (never trailers / block 0)
//   node scripts/nfc-test.js selftest [block]           write a test pattern to a block (default 12,
//                                                       an unused sector-3 block), read it back, then
//                                                       restore the original bytes
//
// Options: --port <COMx|/dev/ttyUSBx|auto>  --baud 115200  --mock (emulated reader)
// Every frame is logged to data/logs/nfc-YYYY-MM-DD.log; add --verbose to echo it here.

'use strict';

const path = require('path');
const config = require('../src/config');
const log = require('../src/nfc/nfc-log');
const layout = require('../src/nfc/card-layout');
const cardService = require('../src/nfc/card-service');
const { PN532 } = require('../src/nfc/pn532');
const { Pn532Emulator } = require('../src/nfc/pn532-emulator');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--port', '--baud'].includes(args[i - 1])));
const [command, ...rest] = positional;

log.configure({ dir: config.logDir, echoToConsole: flag('verbose') });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function hexdump(buf) {
  return buf.toString('hex').replace(/(..)/g, '$1 ').trim().toUpperCase();
}

async function listPorts() {
  const { SerialPort } = require('serialport');
  const ports = await SerialPort.list();
  if (!ports.length) return console.log('No serial ports found.');
  for (const p of ports) {
    console.log(`${p.path.padEnd(14)} ${p.friendlyName || p.manufacturer || ''}${p.vendorId ? `  (VID ${p.vendorId} PID ${p.productId})` : ''}`);
  }
}

async function connect() {
  if (flag('mock') || config.nfc.mock) {
    const emulator = new Pn532Emulator({ storeFile: path.join(config.dataDir, 'mock-cards.json') });
    const uid = emulator.listCards()[0]?.uid || emulator.createCard();
    emulator.placeInField(uid);
    console.log(`(mock reader, card ${uid} in the field)`);
    const pn = new PN532(emulator);
    await pn.init();
    return pn;
  }
  let portPath = option('port', config.nfc.port);
  const baud = Number(option('baud', config.nfc.baudRate));
  if (portPath === 'auto') {
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    const usb = ports.find((p) => p.vendorId);
    if (!usb) throw new Error('No USB serial adapter found. Plug in the PN532 or pass --port COMx (see: nfc-test ports).');
    portPath = usb.path;
  }
  console.log(`Opening ${portPath} @ ${baud} baud...`);
  const pn = await PN532.openSerial(portPath, baud);
  try {
    const fw = await pn.init();
    console.log(`PN532 OK: ${fw.text}`);
  } catch (err) {
    pn.close();
    throw err;
  }
  return pn;
}

async function waitForCard(pn, timeoutMs = 30000) {
  console.log('Tap a card on the reader...');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const target = await pn.detectCard();
    if (target) {
      console.log(`Card: UID ${target.uidHex} (${target.uid.length} bytes), ATQA 0x${target.atqa.toString(16).padStart(4, '0')}, SAK 0x${target.sak.toString(16).padStart(2, '0')}${target.isMifareClassic ? ' — MIFARE Classic' : ' — NOT MIFARE Classic'}`);
      return target;
    }
    await delay(200);
  }
  throw new Error('No card seen within 30 s');
}

function parseBlock(value) {
  const block = Number(value);
  if (!Number.isInteger(block) || block < 0 || block > 63) throw new Error('Block must be 0-63 (MIFARE Classic 1K)');
  return block;
}

async function main() {
  if (!command || command === 'help' || flag('help')) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  if (command === 'ports') return listPorts();

  const pn = await connect();
  try {
    switch (command) {
      case 'info':
        break;

      case 'wait':
        await waitForCard(pn);
        break;

      case 'dump': {
        const target = await waitForCard(pn);
        const card = await cardService.readCard(pn, target.uidHex);
        console.log('\nRaw blocks:');
        for (const [block, hex] of Object.entries(card.raw)) console.log(`  block ${String(block).padStart(2)}: ${hexdump(Buffer.from(hex, 'hex'))}`);
        console.log('\nDecoded (per card-layout.js):');
        console.log(`  pending recharge amount : Rs ${(card.amountPaise / 100).toFixed(2)} (${card.amountPaise} paise)`);
        console.log(`  recharge counter        : ${card.counter}`);
        console.log(`  last recharge amount    : Rs ${(card.lastAmountPaise / 100).toFixed(2)}`);
        console.log(`  billing cycle           : ${card.cycleYear ? `${card.cycleYear}-${String(card.cycleMonth).padStart(2, '0')}` : '(not set)'}, units ${card.cycleUnitsConsumed}`);
        console.log(`  service / meter number  : "${card.serviceNumber}"`);
        console.log(`  tariff                  : ${card.tariff ? `v${card.tariff.version}, ${card.tariff.slabs.map((s) => `${s.upperLimitUnits ?? '∞'}u@${s.ratePaisePerUnit}p`).join(' ')}` : '(none)'}`);
        console.log(`  blank card              : ${card.blank}`);
        for (const w of card.warnings) console.log(`  WARNING: ${w}`);
        break;
      }

      case 'read': {
        const block = parseBlock(rest[0]);
        const target = await waitForCard(pn);
        await pn.authenticateBlock(block, target.uid);
        const data = await pn.readBlock(block);
        console.log(`block ${block}: ${hexdump(data)}`);
        break;
      }

      case 'write': {
        const block = parseBlock(rest[0]);
        const hex = (rest[1] || '').replace(/[\s:]/g, '');
        if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error('Data must be exactly 32 hex characters (16 bytes)');
        if (layout.isTrailerBlock(block) || layout.isManufacturerBlock(block)) throw new Error(`Block ${block} is a sector trailer / manufacturer block — refusing.`);
        if (!flag('yes')) throw new Error('Writing changes the card. Re-run with --yes to confirm.');
        const target = await waitForCard(pn);
        await pn.authenticateBlock(block, target.uid);
        const before = await pn.readBlock(block);
        await pn.writeBlock(block, Buffer.from(hex, 'hex'));
        const after = await pn.readBlock(block);
        console.log(`before: ${hexdump(before)}\nafter : ${hexdump(after)}`);
        console.log(after.toString('hex') === hex.toLowerCase() ? 'Write verified.' : 'WRITE MISMATCH — read-back differs!');
        break;
      }

      case 'selftest': {
        const block = rest[0] !== undefined ? parseBlock(rest[0]) : 12;
        if (layout.isTrailerBlock(block) || layout.isManufacturerBlock(block)) throw new Error(`Block ${block} is a trailer / manufacturer block — pick a data block.`);
        const target = await waitForCard(pn);
        await pn.authenticateBlock(block, target.uid);
        const original = await pn.readBlock(block);
        console.log(`original block ${block}: ${hexdump(original)}`);
        const pattern = Buffer.from('DE5C0DE5A55A0FF0123456789ABCDEF0', 'hex');
        await pn.writeBlock(block, pattern);
        const readBack = await pn.readBlock(block);
        const ok = readBack.equals(pattern);
        console.log(`test pattern read back: ${ok ? 'OK' : `MISMATCH (${hexdump(readBack)})`}`);
        await pn.writeBlock(block, original);
        const restored = await pn.readBlock(block);
        console.log(`original restored     : ${restored.equals(original) ? 'OK' : 'FAILED — block now holds ' + hexdump(restored)}`);
        if (!ok || !restored.equals(original)) process.exitCode = 1;
        else console.log('\nSelf-test passed: detect, auth (key A), read and write all work.');
        break;
      }

      default:
        throw new Error(`Unknown command "${command}". Run with --help.`);
    }
  } finally {
    await pn.release();
    pn.close();
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exitCode = 1;
});
