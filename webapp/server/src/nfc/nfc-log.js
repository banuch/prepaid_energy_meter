// Raw NFC operation log: every PN532 frame sent/received plus each card-level
// operation, one line each, into <logDir>/nfc-YYYY-MM-DD.log. Meant for
// debugging card-layout mismatches against the firmware — grep a block number
// and you see exactly which bytes went over the wire.

'use strict';

const fs = require('fs');
const path = require('path');

let logDir = null;
let echo = false;

function configure({ dir, echoToConsole = false }) {
  logDir = dir;
  echo = echoToConsole;
  if (logDir) fs.mkdirSync(logDir, { recursive: true });
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function write(kind, message) {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`;
  const line = `${stamp} ${time} ${kind.padEnd(5)} ${message}`;
  if (echo) console.log(`[nfc] ${line}`);
  if (!logDir) return;
  try {
    fs.appendFileSync(path.join(logDir, `nfc-${stamp}.log`), line + '\n');
  } catch (err) {
    // Logging must never break a card operation.
    if (!echo) console.error(`[nfc] log write failed: ${err.message}`);
  }
}

module.exports = {
  configure,
  tx: (buf) => write('TX', buf.toString('hex').replace(/(..)/g, '$1 ').trim()),
  rx: (buf) => write('RX', buf.toString('hex').replace(/(..)/g, '$1 ').trim()),
  op: (message) => write('OP', message),
  error: (message) => write('ERROR', message),
};
