'use strict';

const http = require('http');
const config = require('./config');
const nfcLog = require('./nfc/nfc-log');
const { Reader } = require('./nfc/reader');
const { open } = require('./db');
const { createApp } = require('./app');

nfcLog.configure({ dir: config.logDir, echoToConsole: config.nfc.logToConsole });

const db = open(config.dbPath);
const operators = db.prepare('SELECT COUNT(*) AS n FROM operators').get().n;
if (!operators) {
  console.error('No operators yet. Run "npm run db:init" first to create the admin account.');
  process.exit(1);
}

const reader = new Reader(config.nfc);
const { app, attachWebSocket } = createApp({ db, reader, config });
const server = http.createServer(app);
attachWebSocket(server);

let lastReaderLine = null;
reader.on('status', (s) => {
  const line = s.connected ? `Reader: connected on ${s.port} (${s.firmware})` : s.error ? `Reader: ${s.error} (retrying)` : null;
  if (line && line !== lastReaderLine) console.log(line);
  lastReaderLine = line;
});

server.listen(config.port, config.host, () => {
  console.log(`Recharge station on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`Database: ${config.dbPath}`);
  console.log(`NFC: ${config.nfc.mock ? 'MOCK reader (emulated PN532)' : `port ${config.nfc.port} @ ${config.nfc.baudRate}`} — raw log in ${config.logDir}`);
  reader.start();
});

function shutdown() {
  reader.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
