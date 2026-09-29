-- Desk recharge station database. Standalone: nothing here references any
-- AMR/DLMS/meter-reading system.
--
-- Money is INTEGER paise everywhere (Rs 1 = 100). Timestamps are UTC
-- 'YYYY-MM-DD HH:MM:SS' (SQLite CURRENT_TIMESTAMP); reports convert to local.
--
-- There is NO balance column anywhere, on purpose: the meter keeps the
-- running balance in its own memory and never writes it to the card, so the
-- desk never learns it. The card only carries the latest recharge amount
-- and a counter (see src/nfc/card-layout.js).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS operators (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('operator', 'admin')) DEFAULT 'operator',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS consumers (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  mobile           TEXT NOT NULL,
  address          TEXT,
  -- Written to card block 6 ("service number"); max 16 ASCII characters.
  meter_number     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- Highest recharge counter the desk has written for this consumer's meter.
  -- The meter only credits a card whose counter is above the last one it
  -- applied, and it remembers that per METER, not per card — so a
  -- replacement card must continue from here, never restart at 1.
  recharge_counter INTEGER NOT NULL DEFAULT 0,
  created_by       INTEGER REFERENCES operators(id),
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME
);

CREATE TABLE IF NOT EXISTS cards (
  card_uid          TEXT PRIMARY KEY,               -- hex, upper case
  consumer_id       INTEGER NOT NULL REFERENCES consumers(id),
  status            TEXT NOT NULL CHECK (status IN ('active', 'blocked', 'lost')) DEFAULT 'active',
  -- What the card showed the last time it was tapped AT THE DESK.
  -- Not live meter state — the meter never reports back.
  last_seen_amount  INTEGER,                        -- block 4, paise
  last_seen_counter INTEGER,                        -- block 5 counter
  last_seen_at      DATETIME,
  activated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_by      INTEGER REFERENCES operators(id),
  status_changed_at DATETIME,
  status_note       TEXT
);

CREATE INDEX IF NOT EXISTS idx_cards_consumer ON cards(consumer_id);

CREATE TABLE IF NOT EXISTS recharge_transactions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no         TEXT UNIQUE,
  -- 'issue' = initial credit written when a card is activated.
  type               TEXT NOT NULL CHECK (type IN ('issue', 'recharge')),
  card_uid           TEXT NOT NULL REFERENCES cards(card_uid),
  consumer_id        INTEGER NOT NULL REFERENCES consumers(id),
  meter_number       TEXT NOT NULL,                 -- as written to the card
  amount             INTEGER NOT NULL,              -- paise
  payment_mode       TEXT NOT NULL CHECK (payment_mode IN ('cash', 'upi', 'card', 'cheque', 'free')),
  payment_ref        TEXT,
  -- Card state just before/after the write (the spec's balance_before/after:
  -- the card has no balance, only the pending amount + counter).
  card_amount_before INTEGER,
  counter_before     INTEGER,
  counter_after      INTEGER,
  -- completed: verified on the card. failed: the meter will not credit it.
  -- uncertain: counter write attempted, card couldn't be read back —
  --            resolved automatically the next time that card is tapped.
  status             TEXT NOT NULL CHECK (status IN ('completed', 'uncertain', 'failed')),
  error              TEXT,
  operator_id        INTEGER REFERENCES operators(id),
  timestamp          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at        DATETIME
);

CREATE INDEX IF NOT EXISTS idx_txn_timestamp ON recharge_transactions(timestamp);
CREATE INDEX IF NOT EXISTS idx_txn_card ON recharge_transactions(card_uid);
CREATE INDEX IF NOT EXISTS idx_txn_consumer ON recharge_transactions(consumer_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
