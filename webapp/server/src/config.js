// Runtime configuration. Precedence: environment variables > config.json
// (next to package.json, optional) > defaults below. See config.example.json.

'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.resolve(__dirname, '..');

function loadFile() {
  const file = process.env.CONFIG_FILE || path.join(SERVER_ROOT, 'config.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const file = loadFile();
const env = process.env;

function pick(envName, fileKey, fallback) {
  if (env[envName] !== undefined && env[envName] !== '') return env[envName];
  if (file[fileKey] !== undefined) return file[fileKey];
  return fallback;
}

const truthy = (v) => v === true || v === 'true' || v === '1' || v === 1;

const dataDir = path.resolve(SERVER_ROOT, pick('DATA_DIR', 'dataDir', 'data'));

module.exports = {
  serverRoot: SERVER_ROOT,
  dataDir,
  host: pick('HOST', 'host', '127.0.0.1'),
  port: Number(pick('PORT', 'port', 3000)),
  dbPath: path.resolve(dataDir, pick('DB_FILE', 'dbFile', 'recharge-station.db')),
  logDir: path.resolve(dataDir, 'logs'),
  clientDist: path.resolve(SERVER_ROOT, '..', 'client', 'dist'),

  nfc: {
    // 'auto' tries every USB serial adapter until a PN532 answers.
    port: pick('NFC_PORT', 'nfcPort', 'auto'),
    baudRate: Number(pick('NFC_BAUD', 'nfcBaud', 115200)),
    mock: truthy(pick('NFC_MOCK', 'nfcMock', false)),
    mockStore: path.resolve(dataDir, 'mock-cards.json'),
    pollIntervalMs: Number(pick('NFC_POLL_MS', 'nfcPollMs', 300)),
    logToConsole: truthy(pick('NFC_DEBUG', 'nfcDebug', false)),
  },

  sessionHours: Number(pick('SESSION_HOURS', 'sessionHours', 12)),
};
