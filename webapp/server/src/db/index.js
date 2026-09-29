'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Same slabs as TariffTable.domesticGroupC in the Flutter app
// (lib/models/tariff.dart): TSSPDCL Category I Domestic, Group C.
const DEFAULT_TARIFF = {
  version: 1,
  slabs: [
    { upperLimitUnits: 50, ratePaisePerUnit: 265 },
    { upperLimitUnits: 100, ratePaisePerUnit: 335 },
    { upperLimitUnits: 200, ratePaisePerUnit: 540 },
    { upperLimitUnits: 300, ratePaisePerUnit: 710 },
    { upperLimitUnits: 400, ratePaisePerUnit: 795 },
    { upperLimitUnits: 500, ratePaisePerUnit: 850 },
    { upperLimitUnits: null, ratePaisePerUnit: 995 },
  ],
};

const DEFAULT_SETTINGS = {
  initialCreditPaise: 10000, // Rs 100 written to every newly issued card
  minRechargePaise: 1000,
  maxRechargePaise: 1000000,
  tariff: DEFAULT_TARIFF,
};

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insert.run(key, JSON.stringify(value));
  return db;
}

function getSettings(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = JSON.parse(row.value);
  return out;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

module.exports = { open, getSettings, setSetting, DEFAULT_SETTINGS };
