// Card-level operations on top of the PN532 driver: read the whole prepaid
// card, and write a recharge safely. Knows the card layout (via
// card-layout.js), knows nothing about the database.

'use strict';

const layout = require('./card-layout');
const log = require('./nfc-log');

class CardError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CardError';
    this.code = code;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function selectCard(pn, expectedUidHex) {
  const target = await pn.detectCard();
  if (!target) throw new CardError('No card on the reader', 'NO_CARD');
  if (!target.isMifareClassic) {
    throw new CardError(`This is not a MIFARE Classic card (SAK 0x${target.sak.toString(16)})`, 'NOT_CLASSIC');
  }
  if (expectedUidHex && target.uidHex !== expectedUidHex) {
    throw new CardError(`A different card (${target.uidHex}) is on the reader — expected ${expectedUidHex}`, 'WRONG_CARD');
  }
  return target;
}

// Reads `blocks`, authenticating each sector once.
async function readBlocks(pn, target, blocks) {
  const out = {};
  let sector = null;
  for (const block of blocks) {
    if (layout.sectorOf(block) !== sector) {
      await pn.authenticateBlock(block, target.uid);
      sector = layout.sectorOf(block);
    }
    out[block] = await pn.readBlock(block);
  }
  return out;
}

async function readCard(pn, expectedUidHex) {
  const target = await selectCard(pn, expectedUidHex);
  const blocks = await readBlocks(pn, target, layout.READ_BLOCKS);
  const card = layout.decodeCard(blocks);
  log.op(`card ${target.uidHex}: amount=${card.amountPaise} counter=${card.counter} service="${card.serviceNumber}" tariff=v${card.tariff ? card.tariff.version : 0}`);
  return { uid: target.uidHex, sak: target.sak, ...card };
}

// Writes a recharge (or an initial card issue) to the card on the reader.
//
//   expectedUid      the card the operator was shown — refuse a swapped card
//   expectedCounter  the counter the operator was shown — refuse if the card
//                    changed since (someone else wrote it)
//
// Resolves { committed: 'yes'|'no'|'unknown', card, error }:
//   'no'       the counter block was never written or verifiably didn't
//              change — the meter will not credit anything; safe to retry
//   'yes'      verified by reading the card back
//   'unknown'  the counter write was attempted but the card couldn't be read
//              back (usually pulled away mid-write). Re-tap to find out.
// Throws CardError only for problems before anything was written.
async function writeRecharge(pn, { expectedUid, expectedCounter, amountPaise, counter, serviceNumber, tariff }) {
  const target = await selectCard(pn, expectedUid);

  await pn.authenticateBlock(layout.META_BLOCK, target.uid);
  const previousMeta = await pn.readBlock(layout.META_BLOCK);
  const currentCounter = layout.decodeMeta(previousMeta).counter;
  if (currentCounter !== expectedCounter) {
    throw new CardError(`The card changed since it was read (counter ${expectedCounter} → ${currentCounter}). Read it again.`, 'CHANGED');
  }

  const toWrite = layout.buildRechargeBlocks({ amountPaise, counter, serviceNumber, tariff, previousMeta });
  log.op(`recharge ${target.uidHex}: amount=${amountPaise} counter ${expectedCounter} -> ${counter}`);

  let commitAttempted = false;
  let writeError = null;
  let sector = layout.sectorOf(layout.META_BLOCK); // authenticated above
  try {
    for (const block of layout.WRITE_ORDER) {
      if (layout.sectorOf(block) !== sector) {
        await pn.authenticateBlock(block, target.uid);
        sector = layout.sectorOf(block);
      }
      if (block === layout.COMMIT_BLOCK) commitAttempted = true;
      await pn.writeBlock(block, toWrite[block]);
    }
  } catch (err) {
    writeError = err;
    log.error(`recharge ${target.uidHex} write failed (commit ${commitAttempted ? 'attempted' : 'not reached'}): ${err.message}`);
  }

  if (writeError && !commitAttempted) {
    return { committed: 'no', card: null, error: `Card write failed before the recharge took effect: ${writeError.message}` };
  }

  // Read back. A few attempts, since the usual failure is a card lifted a
  // moment too early.
  let verifyError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const after = await readCard(pn, target.uidHex);
      const landed = after.raw[layout.COMMIT_BLOCK] === toWrite[layout.COMMIT_BLOCK].toString('hex');
      if (!landed) {
        return {
          committed: 'no',
          card: after,
          error: `Card write failed — the card still shows the old recharge: ${writeError ? writeError.message : 'read-back mismatch'}`,
        };
      }
      const mismatched = layout.WRITE_ORDER.filter((b) => after.raw[b] !== toWrite[b].toString('hex'));
      if (mismatched.length) {
        log.error(`recharge ${target.uidHex}: committed but blocks ${mismatched.join(',')} read back differently`);
        after.warnings.push(`Recharge applied, but block(s) ${mismatched.join(', ')} read back differently than written.`);
      }
      log.op(`recharge ${target.uidHex}: verified`);
      return { committed: 'yes', card: after, error: null };
    } catch (err) {
      verifyError = err;
      await delay(150);
    }
  }
  return {
    committed: 'unknown',
    card: null,
    error: `The card was written but couldn't be read back to confirm (${(writeError || verifyError).message}). Put the card back on the reader to check.`,
  };
}

module.exports = { CardError, selectCard, readBlocks, readCard, writeRecharge };
