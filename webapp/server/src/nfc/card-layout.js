// Card memory layout — the ONE place the desk app knows where things live on
// the card. It MUST match what the meter firmware reads:
//   firmware/firmware.ino   (AMOUNT_BLOCK, META_BLOCK, TARIFF_* constants)
//   firmware/nfc_card.ino   (layout doc + decoding)
// and what the Flutter app writes (lib/services/nfc_service.dart).
// If you change a block number or offset here, change it there too.
//
// MIFARE Classic 1K, authenticated with Key A.
//
// IMPORTANT — the card is a recharge VOUCHER, not a balance store:
// the meter keeps the running balance in its own NVS and never writes the
// card. Block 4 holds only the amount of the latest recharge; the meter
// credits it once, when the card's counter (block 5) is higher than the last
// counter that meter applied. The desk therefore can never read a consumer's
// live balance off the card.
//
// Sector 1
//   block 4  amount              bytes 0-3   uint32 BE, paise — the pending
//                                             recharge amount (NOT a balance)
//   block 5  recharge meta       bytes 0-3   recharge counter, uint32 BE
//                                bytes 4-7   last recharge amount, paise, uint32 BE
//                                byte  8     billing-cycle year offset from 2020
//                                byte  9     billing-cycle month (1-12)
//                                bytes 10-13 units consumed this cycle, uint32 BE
//                                             (informational; the meter never
//                                             writes it back, so it's stale)
//                                bytes 14-15 reserved
//   block 6  service number      16 bytes ASCII, zero-padded (= consumer's
//                                meter number in the desk DB)
//   block 7  sector trailer      never written by this app
//
// Sector 2
//   block 8  tariff header       byte 0 version (0 = none), byte 1 slab count
//   block 9  tariff slabs 1-4    4 bytes/slab: upperLimit uint16 BE,
//                                rate paise/unit uint16 BE
//   block 10 tariff slabs 5-8    same; unused slots zeroed.
//                                upperLimit 0xFFFF = unbounded (last slab)
//
// TODO(security): plain MIFARE Classic with the factory Key A (FF FF FF FF FF
// FF) and no MAC/signature has NO protection against cloning or replay. Anyone
// with a generic NFC writer (or a phone) can copy a card, rewrite block 4/5
// with any amount and a higher counter, and the meter will credit it. There
// is also no checksum on the card data (the firmware doesn't define one, so
// the desk can't add one without a firmware change). Before field
// deployment: diversified per-card keys + restricted access bits at minimum,
// ideally a MAC over blocks 4-6 verified by the meter, or move to DESFire EV2/3.
// Not fixed here on purpose — it needs a matching firmware change.

'use strict';

const KEY_A = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

const BLOCK_SIZE = 16;

const AMOUNT_BLOCK = 4;
const META_BLOCK = 5;
const SERVICE_NUMBER_BLOCK = 6;

const TARIFF_HEADER_BLOCK = 8;
const TARIFF_SLAB_BLOCK_1 = 9;
const TARIFF_SLAB_BLOCK_2 = 10;

const META = {
  COUNTER: 0,
  LAST_AMOUNT: 4,
  CYCLE_YEAR: 8,
  CYCLE_MONTH: 9,
  CYCLE_UNITS: 10,
};

const CYCLE_YEAR_BASE = 2020;
const SERVICE_NUMBER_MAX_LENGTH = 16;
const UNBOUNDED_SENTINEL = 0xffff;
const MAX_SLABS = 8;
const UINT32_MAX = 0xffffffff;

// Blocks the desk reads on every tap, and the order it writes them in a
// recharge. The counter block (META_BLOCK) is written LAST: until it lands,
// the meter still sees the old counter and ignores the new amount, so a write
// that dies half-way can never credit the meter by accident.
const READ_BLOCKS = [AMOUNT_BLOCK, META_BLOCK, SERVICE_NUMBER_BLOCK, TARIFF_HEADER_BLOCK, TARIFF_SLAB_BLOCK_1, TARIFF_SLAB_BLOCK_2];
const WRITE_ORDER = [SERVICE_NUMBER_BLOCK, TARIFF_HEADER_BLOCK, TARIFF_SLAB_BLOCK_1, TARIFF_SLAB_BLOCK_2, AMOUNT_BLOCK, META_BLOCK];
const COMMIT_BLOCK = META_BLOCK;

// MIFARE Classic 1K: 16 sectors x 4 blocks, the last block of each is the trailer.
function sectorOf(block) {
  return Math.floor(block / 4);
}

function isTrailerBlock(block) {
  return block % 4 === 3;
}

function isManufacturerBlock(block) {
  return block === 0;
}

function emptyBlock() {
  return Buffer.alloc(BLOCK_SIZE);
}

function assertBlock(data) {
  if (!Buffer.isBuffer(data) || data.length !== BLOCK_SIZE) {
    throw new Error(`Expected a ${BLOCK_SIZE}-byte block`);
  }
}

function assertUint32(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Error(`${name} must be an integer between 0 and ${UINT32_MAX}`);
  }
}

// --- block 4 -----------------------------------------------------------------

function decodeAmount(block) {
  assertBlock(block);
  return block.readUInt32BE(0);
}

function encodeAmount(amountPaise) {
  assertUint32('amountPaise', amountPaise);
  const block = emptyBlock();
  block.writeUInt32BE(amountPaise, 0);
  return block;
}

// --- block 5 -----------------------------------------------------------------

function decodeMeta(block) {
  assertBlock(block);
  const yearOffset = block.readUInt8(META.CYCLE_YEAR);
  return {
    counter: block.readUInt32BE(META.COUNTER),
    lastAmountPaise: block.readUInt32BE(META.LAST_AMOUNT),
    cycleYear: yearOffset === 0 ? 0 : CYCLE_YEAR_BASE + yearOffset,
    cycleMonth: block.readUInt8(META.CYCLE_MONTH),
    cycleUnitsConsumed: block.readUInt32BE(META.CYCLE_UNITS),
    reserved: block.subarray(14, 16).toString('hex'),
  };
}

// `previous` is the block as read off the card; fields a recharge doesn't own
// (billing cycle, reserved bytes) are carried over byte-for-byte, same as the
// Flutter app does.
function encodeMeta({ counter, lastAmountPaise }, previous) {
  assertUint32('counter', counter);
  assertUint32('lastAmountPaise', lastAmountPaise);
  const block = previous ? Buffer.from(previous) : emptyBlock();
  assertBlock(block);
  block.writeUInt32BE(counter, META.COUNTER);
  block.writeUInt32BE(lastAmountPaise, META.LAST_AMOUNT);
  return block;
}

// --- block 6 -----------------------------------------------------------------

function decodeServiceNumber(block) {
  assertBlock(block);
  const end = block.indexOf(0);
  return block.subarray(0, end === -1 ? BLOCK_SIZE : end).toString('latin1');
}

function validateServiceNumber(serviceNumber) {
  if (typeof serviceNumber !== 'string' || serviceNumber.length === 0) {
    return 'Meter number is required';
  }
  if (serviceNumber.length > SERVICE_NUMBER_MAX_LENGTH) {
    return `Meter number must be at most ${SERVICE_NUMBER_MAX_LENGTH} characters (it is stored in one 16-byte card block)`;
  }
  if (!/^[\x20-\x7e]+$/.test(serviceNumber)) {
    return 'Meter number may only contain plain ASCII letters, digits and symbols';
  }
  return null;
}

function encodeServiceNumber(serviceNumber) {
  const error = validateServiceNumber(serviceNumber);
  if (error) throw new Error(error);
  const block = emptyBlock();
  block.write(serviceNumber, 0, 'latin1');
  return block;
}

// --- blocks 8-10 -------------------------------------------------------------

// Tariff shape used across the app:
//   { version: 1..255, slabs: [{ upperLimitUnits: number|null, ratePaisePerUnit }] }
// upperLimitUnits null = unbounded (only valid on the last slab).

function decodeTariff(header, slabs1, slabs2) {
  assertBlock(header);
  const version = header[0];
  const slabCount = header[1];
  if (version === 0 || slabCount === 0) return null;

  const combined = Buffer.concat([slabs1 || emptyBlock(), slabs2 || emptyBlock()]);
  const slabs = [];
  for (let i = 0; i < Math.min(slabCount, MAX_SLABS); i++) {
    const limit = combined.readUInt16BE(i * 4);
    slabs.push({
      upperLimitUnits: limit === UNBOUNDED_SENTINEL ? null : limit,
      ratePaisePerUnit: combined.readUInt16BE(i * 4 + 2),
    });
  }
  return { version, slabs };
}

function validateTariff(tariff) {
  if (!tariff || typeof tariff !== 'object') return 'Tariff is required';
  if (!Number.isInteger(tariff.version) || tariff.version < 1 || tariff.version > 255) {
    return 'Tariff version must be 1-255';
  }
  const { slabs } = tariff;
  if (!Array.isArray(slabs) || slabs.length === 0 || slabs.length > MAX_SLABS) {
    return `Tariff needs 1-${MAX_SLABS} slabs`;
  }
  let previousLimit = 0;
  for (let i = 0; i < slabs.length; i++) {
    const { upperLimitUnits, ratePaisePerUnit } = slabs[i];
    const last = i === slabs.length - 1;
    if (!Number.isInteger(ratePaisePerUnit) || ratePaisePerUnit < 1 || ratePaisePerUnit > 0xffff) {
      return `Slab ${i + 1}: rate must be 1-65535 paise/unit`;
    }
    if (upperLimitUnits === null) {
      if (!last) return `Slab ${i + 1}: only the last slab can be unbounded`;
      continue;
    }
    if (!Number.isInteger(upperLimitUnits) || upperLimitUnits <= previousLimit || upperLimitUnits >= UNBOUNDED_SENTINEL) {
      return `Slab ${i + 1}: upper limit must be a whole number above ${previousLimit} and below ${UNBOUNDED_SENTINEL}`;
    }
    previousLimit = upperLimitUnits;
  }
  return null;
}

function encodeTariff(tariff) {
  const error = validateTariff(tariff);
  if (error) throw new Error(error);

  const header = emptyBlock();
  header[0] = tariff.version;
  header[1] = tariff.slabs.length;

  const combined = Buffer.alloc(BLOCK_SIZE * 2);
  tariff.slabs.forEach((slab, i) => {
    combined.writeUInt16BE(slab.upperLimitUnits === null ? UNBOUNDED_SENTINEL : slab.upperLimitUnits, i * 4);
    combined.writeUInt16BE(slab.ratePaisePerUnit, i * 4 + 2);
  });

  return {
    [TARIFF_HEADER_BLOCK]: header,
    [TARIFF_SLAB_BLOCK_1]: combined.subarray(0, BLOCK_SIZE),
    [TARIFF_SLAB_BLOCK_2]: combined.subarray(BLOCK_SIZE),
  };
}

// --- whole card --------------------------------------------------------------

// Turns the raw blocks read off a card ({ [blockNumber]: Buffer }) into the
// card object the rest of the app uses. There's no checksum on the card, so
// "sanity" catches only obvious garbage (unreadable bytes in the service
// number, an impossible billing month, a counter without an amount history).
function decodeCard(blocks) {
  const meta = decodeMeta(blocks[META_BLOCK]);
  const amountPaise = decodeAmount(blocks[AMOUNT_BLOCK]);
  const serviceNumber = decodeServiceNumber(blocks[SERVICE_NUMBER_BLOCK]);
  const tariff = blocks[TARIFF_HEADER_BLOCK]
    ? decodeTariff(blocks[TARIFF_HEADER_BLOCK], blocks[TARIFF_SLAB_BLOCK_1], blocks[TARIFF_SLAB_BLOCK_2])
    : null;

  const warnings = [];
  if (serviceNumber && validateServiceNumber(serviceNumber)) {
    warnings.push('Service number block contains non-text bytes — the card may be corrupted or from another system.');
  }
  if (meta.cycleMonth > 12) {
    warnings.push('Billing-cycle month on the card is out of range — the card may be corrupted.');
  }
  if (meta.counter === 0 && amountPaise !== 0) {
    warnings.push('Card holds an amount but no recharge counter — the meter will never credit it.');
  }

  const blank = meta.counter === 0 && amountPaise === 0 && serviceNumber === '' && !tariff;

  return {
    amountPaise,
    counter: meta.counter,
    lastAmountPaise: meta.lastAmountPaise,
    cycleYear: meta.cycleYear,
    cycleMonth: meta.cycleMonth,
    cycleUnitsConsumed: meta.cycleUnitsConsumed,
    serviceNumber,
    tariff,
    blank,
    warnings,
    raw: Object.fromEntries(Object.entries(blocks).map(([block, data]) => [block, data.toString('hex')])),
  };
}

// The blocks a recharge writes, keyed by block number. `previousMeta` is block
// 5 as read just before, so billing-cycle bytes survive.
function buildRechargeBlocks({ amountPaise, counter, serviceNumber, tariff, previousMeta }) {
  return {
    [SERVICE_NUMBER_BLOCK]: encodeServiceNumber(serviceNumber),
    ...encodeTariff(tariff),
    [AMOUNT_BLOCK]: encodeAmount(amountPaise),
    [META_BLOCK]: encodeMeta({ counter, lastAmountPaise: amountPaise }, previousMeta),
  };
}

module.exports = {
  KEY_A,
  BLOCK_SIZE,
  AMOUNT_BLOCK,
  META_BLOCK,
  SERVICE_NUMBER_BLOCK,
  TARIFF_HEADER_BLOCK,
  TARIFF_SLAB_BLOCK_1,
  TARIFF_SLAB_BLOCK_2,
  META,
  SERVICE_NUMBER_MAX_LENGTH,
  UNBOUNDED_SENTINEL,
  MAX_SLABS,
  UINT32_MAX,
  READ_BLOCKS,
  WRITE_ORDER,
  COMMIT_BLOCK,
  sectorOf,
  isTrailerBlock,
  isManufacturerBlock,
  decodeAmount,
  encodeAmount,
  decodeMeta,
  encodeMeta,
  decodeServiceNumber,
  encodeServiceNumber,
  validateServiceNumber,
  decodeTariff,
  encodeTariff,
  validateTariff,
  decodeCard,
  buildRechargeBlocks,
};
