#!/usr/bin/env node
// Creates the SQLite database (schema + default settings) and the first
// admin account. Safe to re-run: existing data is kept.
//
//   npm run db:init
//   npm run db:init -- --admin-password "S0me-strong-pass"

'use strict';

const crypto = require('crypto');
const config = require('../src/config');
const { open } = require('../src/db');
const { hashPassword, validatePassword } = require('../src/auth');

const args = process.argv.slice(2);
const i = args.indexOf('--admin-password');
const given = i !== -1 ? args[i + 1] : process.env.ADMIN_PASSWORD;

const db = open(config.dbPath);
console.log(`Database ready: ${config.dbPath}`);

const admins = db.prepare("SELECT COUNT(*) AS n FROM operators WHERE role = 'admin'").get().n;
if (admins) {
  console.log('An admin account already exists — nothing else to do.');
} else {
  const password = given || crypto.randomBytes(9).toString('base64url');
  const err = validatePassword(password);
  if (err) {
    console.error(err);
    process.exit(1);
  }
  db.prepare("INSERT INTO operators (name, username, password_hash, role) VALUES ('Administrator', 'admin', ?, 'admin')").run(hashPassword(password));
  console.log('\nCreated admin account:');
  console.log('  username: admin');
  console.log(`  password: ${given ? '(as given)' : password}`);
  if (!given) console.log('\nWrite this password down and change it after first login (top-right menu → Change password).');
}
db.close();
