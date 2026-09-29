// Desk operations that touch both the card and the database: what a tapped
// card means, card issue (registration) and recharge.
//
// Ground rules (see card-layout.js for why):
//  - Every decision is made on a fresh read of the physical card, never on
//    what the DB last saw.
//  - The card holds the latest recharge amount + a counter, not a balance.
//    The desk never claims to know a consumer's balance.
//  - The recharge counter is per meter (consumers.recharge_counter) and only
//    ever goes up.

'use strict';

const layout = require('../nfc/card-layout');
const cardService = require('../nfc/card-service');
const { getSettings } = require('../db');
const { AppError, badRequest, notFound, conflict } = require('../errors');

const PAYMENT_MODES = ['cash', 'upi', 'card', 'cheque', 'free'];

function normalizeMobile(mobile) {
  const digits = String(mobile || '').replace(/[\s-]/g, '').replace(/^(\+91|0091|0)/, '');
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

function validateConsumerInput(input, { partial = false } = {}) {
  const out = {};
  const errors = {};
  if (!partial || input.name !== undefined) {
    const name = String(input.name || '').trim();
    if (!name) errors.name = 'Name is required';
    else if (name.length > 100) errors.name = 'Name is too long';
    out.name = name;
  }
  if (!partial || input.mobile !== undefined) {
    const mobile = normalizeMobile(input.mobile);
    if (!mobile) errors.mobile = 'Enter a 10-digit Indian mobile number';
    out.mobile = mobile;
  }
  if (!partial || input.address !== undefined) {
    const address = String(input.address || '').trim();
    if (address.length > 300) errors.address = 'Address is too long';
    out.address = address || null;
  }
  if (!partial || input.meterNumber !== undefined) {
    const meterNumber = String(input.meterNumber || '').trim().toUpperCase();
    const err = layout.validateServiceNumber(meterNumber);
    if (err) errors.meterNumber = err;
    out.meter_number = meterNumber;
  }
  if (Object.keys(errors).length) throw badRequest('Please correct the highlighted fields', { fields: errors });
  return out;
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function receiptNo(id) {
  const d = new Date();
  return `R${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(id, 5)}`;
}

class Desk {
  constructor(db, reader) {
    this.db = db;
    this.reader = reader;
    this.q = {
      card: db.prepare('SELECT * FROM cards WHERE card_uid = ?'),
      consumer: db.prepare('SELECT * FROM consumers WHERE id = ?'),
      consumerByMeter: db.prepare('SELECT * FROM consumers WHERE meter_number = ?'),
      activeCardsOf: db.prepare("SELECT * FROM cards WHERE consumer_id = ? AND status = 'active'"),
      lastTxn: db.prepare(
        `SELECT t.*, o.name AS operator_name FROM recharge_transactions t LEFT JOIN operators o ON o.id = t.operator_id
         WHERE t.card_uid = ? AND t.status = 'completed' ORDER BY t.id DESC LIMIT 1`,
      ),
      uncertain: db.prepare("SELECT * FROM recharge_transactions WHERE card_uid = ? AND status = 'uncertain' ORDER BY id"),
      resolveTxn: db.prepare("UPDATE recharge_transactions SET status = ?, error = COALESCE(?, error), resolved_at = CURRENT_TIMESTAMP WHERE id = ?"),
      seen: db.prepare('UPDATE cards SET last_seen_amount = ?, last_seen_counter = ?, last_seen_at = CURRENT_TIMESTAMP WHERE card_uid = ?'),
      bumpCounter: db.prepare('UPDATE consumers SET recharge_counter = MAX(recharge_counter, ?) WHERE id = ?'),
      insertTxn: db.prepare(
        `INSERT INTO recharge_transactions
           (type, card_uid, consumer_id, meter_number, amount, payment_mode, payment_ref,
            card_amount_before, counter_before, counter_after, status, error, operator_id)
         VALUES (@type, @card_uid, @consumer_id, @meter_number, @amount, @payment_mode, @payment_ref,
            @card_amount_before, @counter_before, @counter_after, @status, @error, @operator_id)`,
      ),
      setReceipt: db.prepare('UPDATE recharge_transactions SET receipt_no = ? WHERE id = ?'),
      txn: db.prepare(
        `SELECT t.*, c.name AS consumer_name, c.mobile, o.name AS operator_name FROM recharge_transactions t
         JOIN consumers c ON c.id = t.consumer_id LEFT JOIN operators o ON o.id = t.operator_id WHERE t.id = ?`,
      ),
    };
  }

  settings() {
    return getSettings(this.db);
  }

  // --- tap handling ------------------------------------------------------------

  // Resolves 'uncertain' writes against what the card shows now, and records
  // the desk visit. Called for every successful read of a known card.
  recordTap(card) {
    const row = this.q.card.get(card.uid);
    if (!row) return;
    this.db.transaction(() => {
      for (const txn of this.q.uncertain.all(card.uid)) {
        if (card.counter === txn.counter_after && card.amountPaise === txn.amount) {
          this.q.resolveTxn.run('completed', null, txn.id);
        } else if (card.counter < txn.counter_after) {
          this.q.resolveTxn.run('failed', 'Re-read of the card showed the write never landed', txn.id);
        }
        // counter above it: something else wrote the card since — leave for an admin
      }
      this.q.seen.run(card.amountPaise, card.counter, card.uid);
    })();
  }

  // What a tapped card means to the desk: which consumer, can it be
  // recharged, and anything the operator should be warned about.
  describe(card) {
    const row = this.q.card.get(card.uid);
    const warnings = [...card.warnings];

    if (!row) {
      const sameMeter = card.serviceNumber ? this.q.consumerByMeter.get(card.serviceNumber) : null;
      if (!card.blank) {
        warnings.push(
          `This card isn't registered here but already holds data (meter "${card.serviceNumber || '—'}", recharge #${card.counter}).` +
            (sameMeter ? ` That meter belongs to ${sameMeter.name} — maybe a card issued outside this desk.` : ''),
        );
      }
      return { known: false, warnings, meterConsumer: sameMeter ? { id: sameMeter.id, name: sameMeter.name } : null };
    }

    const consumer = this.q.consumer.get(row.consumer_id);
    if (row.status !== 'active') {
      warnings.unshift(`This card is marked ${row.status.toUpperCase()}${row.status_note ? ` (${row.status_note})` : ''} — it can't be recharged.`);
    }
    if (card.serviceNumber !== consumer.meter_number) {
      warnings.push(`The card is written for meter "${card.serviceNumber || '(blank)'}" but ${consumer.name}'s meter is "${consumer.meter_number}". A recharge will rewrite it.`);
    }
    if (card.counter > consumer.recharge_counter) {
      warnings.push(
        `The card's recharge counter (#${card.counter}) is higher than any this desk wrote (#${consumer.recharge_counter}) — it was recharged somewhere else (another app or writer).`,
      );
    }
    const uncertain = this.q.uncertain.all(card.uid);
    if (uncertain.length) {
      warnings.push(`${uncertain.length} earlier write(s) to this card could not be confirmed and still need an admin's attention.`);
    }

    return {
      known: true,
      cardRecord: row,
      consumer,
      lastTransaction: this.q.lastTxn.get(card.uid) || null,
      canRecharge: row.status === 'active',
      // The pending amount may still be unused if the consumer hasn't tapped
      // the meter since; a recharge overwrites it, so the operator must ask.
      needsMeterTapConfirmation: card.amountPaise > 0,
      warnings,
    };
  }

  // --- writes ------------------------------------------------------------------

  _readForWrite(pn, uid, expectedCounter) {
    return cardService.readCard(pn, uid).then((card) => {
      this.recordTap(card);
      if (card.counter !== expectedCounter) {
        throw conflict('CARD_CHANGED', `The card changed since it was shown (recharge #${expectedCounter} → #${card.counter}). Check it again before continuing.`);
      }
      return card;
    });
  }

  _cardError(err) {
    if (err instanceof AppError) return err;
    const map = {
      NO_CARD: [409, 'Put the card back on the reader and try again.'],
      WRONG_CARD: [409, null],
      NOT_CLASSIC: [422, null],
      CHANGED: [409, null],
      NO_READER: [503, null],
      AUTH: [422, null],
    };
    const [status, message] = map[err.code] || [502, null];
    return new AppError(status, err.code || 'CARD_ERROR', message || err.message);
  }

  _insertTxn(fields) {
    const id = this.q.insertTxn.run(fields).lastInsertRowid;
    this.q.setReceipt.run(receiptNo(id), id);
    return this.q.txn.get(id);
  }

  _outcome(write) {
    return { yes: 'completed', no: 'failed', unknown: 'uncertain' }[write.committed];
  }

  // Issue a card: to a new consumer (`consumer` fields) or as a replacement
  // for an existing one (`consumerId`). Writes the initial credit.
  async issueCard(body, operator) {
    const uid = String(body.uid || '').toUpperCase();
    if (!uid) throw badRequest('Tap a card first');
    if (!Number.isInteger(body.expectedCounter)) throw badRequest('expectedCounter is required');
    const paymentMode = body.paymentMode || 'cash';
    if (!PAYMENT_MODES.includes(paymentMode)) throw badRequest('Unknown payment mode');
    const startCounter = body.meterLastCounter === undefined || body.meterLastCounter === null || body.meterLastCounter === '' ? 0 : Number(body.meterLastCounter);
    if (!Number.isInteger(startCounter) || startCounter < 0 || startCounter >= layout.UINT32_MAX) throw badRequest("Meter's last recharge counter must be a whole number");

    const existingCard = this.q.card.get(uid);
    if (existingCard) {
      const owner = this.q.consumer.get(existingCard.consumer_id);
      throw conflict('CARD_REGISTERED', `This card is already registered to ${owner.name} (meter ${owner.meter_number}).`, { consumerId: owner.id });
    }

    let consumer = null;
    let newConsumer = null;
    let replacing = [];
    if (body.consumerId) {
      consumer = this.q.consumer.get(body.consumerId);
      if (!consumer) throw notFound('Consumer not found');
      replacing = this.q.activeCardsOf.all(consumer.id);
      if (replacing.length && !body.replaceActiveCards) {
        throw conflict('HAS_ACTIVE_CARD', `${consumer.name} already has an active card (${replacing.map((c) => c.card_uid).join(', ')}). Confirm it should be marked lost and replaced.`, {
          cards: replacing.map((c) => c.card_uid),
        });
      }
    } else {
      newConsumer = validateConsumerInput(body.consumer || {});
      const clash = this.q.consumerByMeter.get(newConsumer.meter_number);
      if (clash) throw badRequest(`Meter ${newConsumer.meter_number} is already registered to ${clash.name}`, { fields: { meterNumber: 'Already registered' }, consumerId: clash.id });
    }

    const settings = this.settings();
    const amount = settings.initialCreditPaise;
    const meterNumber = consumer ? consumer.meter_number : newConsumer.meter_number;
    const priorCounter = consumer ? consumer.recharge_counter : 0;

    let before;
    let counter;
    let write;
    try {
      ({ before, counter, write } = await this.reader.exclusive(async (pn) => {
        const card = await this._readForWrite(pn, uid, body.expectedCounter);
        if (!card.blank && !body.confirmOverwrite) {
          throw conflict('CARD_NOT_BLANK', 'This card already holds data. Confirm it may be overwritten.', { card });
        }
        const next = Math.max(priorCounter, card.counter, startCounter) + 1;
        if (consumer) this.q.bumpCounter.run(next, consumer.id);
        const result = await cardService.writeRecharge(pn, {
          expectedUid: uid,
          expectedCounter: card.counter,
          amountPaise: amount,
          counter: next,
          serviceNumber: meterNumber,
          tariff: settings.tariff,
        });
        return { before: card, counter: next, write: result };
      }));
    } catch (err) {
      throw this._cardError(err);
    }

    if (write.committed === 'no') {
      throw new AppError(502, 'WRITE_FAILED', `${write.error} Nothing was saved — you can safely try again.`);
    }

    const txn = this.db.transaction(() => {
      let consumerId = consumer && consumer.id;
      if (newConsumer) {
        consumerId = this.db
          .prepare('INSERT INTO consumers (name, mobile, address, meter_number, recharge_counter, created_by) VALUES (?, ?, ?, ?, ?, ?)')
          .run(newConsumer.name, newConsumer.mobile, newConsumer.address, newConsumer.meter_number, counter, operator.id).lastInsertRowid;
      }
      for (const old of replacing) {
        this.db
          .prepare("UPDATE cards SET status = 'lost', status_changed_at = CURRENT_TIMESTAMP, status_note = ? WHERE card_uid = ?")
          .run(`Replaced by card ${uid}`, old.card_uid);
      }
      this.db
        .prepare('INSERT INTO cards (card_uid, consumer_id, activated_by, last_seen_amount, last_seen_counter, last_seen_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
        .run(uid, consumerId, operator.id, write.card ? write.card.amountPaise : null, write.card ? write.card.counter : null);
      return this._insertTxn({
        type: 'issue',
        card_uid: uid,
        consumer_id: consumerId,
        meter_number: meterNumber,
        amount,
        payment_mode: paymentMode,
        payment_ref: body.paymentRef || null,
        card_amount_before: before.amountPaise,
        counter_before: before.counter,
        counter_after: counter,
        status: this._outcome(write),
        error: write.error,
        operator_id: operator.id,
      });
    })();

    return { transaction: txn, consumer: this.q.consumer.get(txn.consumer_id), card: write.card, committed: write.committed, error: write.error };
  }

  async recharge(body, operator) {
    const uid = String(body.uid || '').toUpperCase();
    const row = this.q.card.get(uid);
    if (!row) throw conflict('UNKNOWN_CARD', 'This card is not registered. Register it first.');
    if (row.status !== 'active') throw conflict('CARD_INACTIVE', `This card is marked ${row.status} and can't be recharged.`);
    if (!Number.isInteger(body.expectedCounter)) throw badRequest('expectedCounter is required');

    const settings = this.settings();
    const amount = body.amountPaise;
    if (!Number.isInteger(amount) || amount < settings.minRechargePaise || amount > settings.maxRechargePaise) {
      throw badRequest(`Amount must be between ₹${settings.minRechargePaise / 100} and ₹${settings.maxRechargePaise / 100}`, { fields: { amount: 'Out of range' } });
    }
    const paymentMode = body.paymentMode;
    if (!PAYMENT_MODES.includes(paymentMode) || paymentMode === 'free') throw badRequest('Choose how the consumer paid', { fields: { paymentMode: 'Required' } });

    const consumer = this.q.consumer.get(row.consumer_id);

    let before;
    let counter;
    let write;
    try {
      ({ before, counter, write } = await this.reader.exclusive(async (pn) => {
        const card = await this._readForWrite(pn, uid, body.expectedCounter);
        if (card.amountPaise > 0 && !body.confirmMeterTapped) {
          throw conflict('CONFIRM_METER_TAPPED', 'Confirm the consumer has tapped this card on their meter since the last recharge — otherwise that amount would be lost.');
        }
        const fresh = this.q.consumer.get(consumer.id);
        const next = Math.max(fresh.recharge_counter, card.counter) + 1;
        // Claim the counter before writing, so a crash mid-write can never reuse it.
        this.q.bumpCounter.run(next, consumer.id);
        const result = await cardService.writeRecharge(pn, {
          expectedUid: uid,
          expectedCounter: card.counter,
          amountPaise: amount,
          counter: next,
          serviceNumber: consumer.meter_number,
          tariff: settings.tariff,
        });
        return { before: card, counter: next, write: result };
      }));
    } catch (err) {
      throw this._cardError(err);
    }

    const txn = this.db.transaction(() => {
      if (write.card) this.q.seen.run(write.card.amountPaise, write.card.counter, uid);
      return this._insertTxn({
        type: 'recharge',
        card_uid: uid,
        consumer_id: consumer.id,
        meter_number: consumer.meter_number,
        amount,
        payment_mode: paymentMode,
        payment_ref: body.paymentRef ? String(body.paymentRef).slice(0, 60) : null,
        card_amount_before: before.amountPaise,
        counter_before: before.counter,
        counter_after: counter,
        status: this._outcome(write),
        error: write.error,
        operator_id: operator.id,
      });
    })();

    if (write.committed === 'no') {
      throw new AppError(502, 'WRITE_FAILED', `${write.error} No money should be collected for this attempt — try again.`, { transactionId: txn.id });
    }
    return { transaction: txn, consumer, card: write.card, committed: write.committed, error: write.error };
  }
}

module.exports = { Desk, validateConsumerInput, normalizeMobile, PAYMENT_MODES };
