# Recharge Station — desk app for the prepaid energy meter

An offline, single-PC app for the EM&W section desk. Operators use it to register consumers, issue cards, recharge cards, look up a card, and run collection reports. A PN532 NFC reader on a USB serial port reads and writes the MIFARE Classic cards.

- **Backend:** Node.js + Express, SQLite (`better-sqlite3`), WebSocket for live card-tap events, and its own PN532 UART driver.
- **Frontend:** React (Vite), built for a touchscreen. The backend serves it from `localhost`.
- **Fully standalone:** it has its own database and server, needs no cloud and no network, and doesn't depend on any AMR/DLMS system.

---

## How the card works (read this first)

The desk app follows **what the meter firmware actually does** (`../firmware/nfc_card.ino`). That differs from the original brief:

| | Original brief | Actual firmware (what this app implements) |
|---|---|---|
| Where the balance lives | On the card | **In the meter's own memory (NVS)** |
| Does the meter write the card? | Yes, after billing | **No, it only reads the card** |
| What block 4 holds | Running balance | **The latest recharge amount only** |
| How double-crediting is prevented | — | **A recharge counter in block 5.** The meter credits block 4 only when the counter is higher than the last one it applied. |

What this means for the desk app:

- **The desk can never show a consumer's balance.** No card, database or report holds it. Screens say so, and show "last recharge on card", the recharge number and the last desk visit instead.
- **A recharge overwrites block 4** (the same as the Flutter app). If the consumer hasn't tapped the card on the meter since the last recharge, that earlier amount would be lost. When the card holds an amount, the operator must confirm the consumer has tapped the meter since.
- **The recharge counter belongs to the meter, not the card.** The meter remembers the last counter it applied, so a replacement card continues from the consumer's last counter (`consumers.recharge_counter`). If the meter was recharged before by another app, an optional field on the Register page takes the meter's `lastAppliedRechargeCounter`, which is shown on the meter's web dashboard.
- **Blocking a card only stops desk recharges.** The meter is offline and can't be told.

### Card layout

It's defined once, in [`server/src/nfc/card-layout.js`](server/src/nfc/card-layout.js), and matches `firmware/firmware.ino` and `lib/services/nfc_service.dart`:

| Block | Contents |
|---|---|
| 4 | Latest recharge amount, uint32 big-endian, paise |
| 5 | Bytes 0–3: recharge counter · 4–7: last amount (paise) · 8: cycle year − 2020 · 9: cycle month · 10–13: cycle units · 14–15: reserved |
| 6 | Service number = consumer's meter number, 16 bytes ASCII, zero-padded |
| 8 | Tariff header: version, slab count |
| 9, 10 | Tariff slabs 1–8: upper limit uint16 (0xFFFF = no limit) + rate paise/unit uint16 |

All sectors use **Key A = FF FF FF FF FF FF**. Trailer blocks and block 0 are never written, and the driver refuses to.

A write goes in this order: blocks 6, 8, 9, 10, 4, then **5 last**. The meter ignores the new amount until the counter changes, so a write interrupted half-way can never credit the meter. After writing, the app reads the card back to check it. The result is one of three:
- **completed:** the read-back matches.
- **failed:** the counter didn't change, so it's safe to retry and no money should be taken.
- **uncertain:** the card was lifted during the counter write. It's settled automatically the next time that card is read at the desk.

The brief asked for a checksum byte, a consumer ID and a timestamp on the card. The firmware defines none of them and blocks 4–6 have no free space, so none were added. Adding them needs a firmware change first.

> **SECURITY TODO (not fixed on purpose):** plain MIFARE Classic with the factory key and no MAC can be cloned or replayed with any NFC writer, including a phone. Someone could write any amount with a higher counter and the meter would credit it. Before field use, at minimum use per-card diversified keys and restrictive access bits. Better, have the meter check a MAC over blocks 4–6, or move to DESFire EV2/EV3. Any of these needs a matching firmware change. See the comment at the top of `card-layout.js`.

---

## Setup

Requirements: **Node.js 20+** on Windows or Linux. `better-sqlite3` and `serialport` ship prebuilt binaries, so no compiler is needed on common platforms.

```bash
cd webapp
npm run setup          # installs server + client deps and builds the UI
npm run db:init        # creates server/data/recharge-station.db and the admin account
```

`db:init` prints a random admin password once. Write it down, then change it after first login (top-right menu → Change password). To choose the password yourself, run `npm run db:init -- --admin-password "your-password"`. Re-running `db:init` is safe: it never touches existing data.

### Point it at the PN532

1. Set the PN532 board to **HSU/UART** mode using its mode switches. On the red Elechouse V3: SEL0 = 0, SEL1 = 0.
2. Plug in the USB-to-serial adapter and find the port:
   ```bash
   npm run nfc-test -- ports
   ```
3. Either leave the port set to `auto` (the default), which tries CH340, CP210x, FTDI and PL2303 adapters first, or pin it:
   - Copy `server/config.example.json` to `server/config.json` and set `"nfcPort": "COM5"` (or `/dev/ttyUSB0`), **or**
   - set the environment variable `NFC_PORT=COM5`.

   The baud rate defaults to 115200, the PN532 HSU default. Change it with `nfcBaud` / `NFC_BAUD`.

### Phase 1 bench test (no UI, no database)

Do this against a real card **before** using the web app:

```bash
npm run nfc-test -- info                 # PN532 answers? prints firmware version
npm run nfc-test -- wait                 # tap a card: prints UID / SAK
npm run nfc-test -- dump                 # reads blocks 4-6 and 8-10 and decodes them per card-layout.js
npm run nfc-test -- selftest             # writes a pattern to block 12 (unused), reads it back, restores it
npm run nfc-test -- read 5
npm run nfc-test -- write 12 00112233445566778899AABBCCDDEEFF --yes
```

Add `--port COM5` to pin a port and `--verbose` to echo every frame. **Check with `dump` on a card the Flutter app or meter has used, to confirm the layout matches, before issuing real cards.**

### Run

```bash
npm start              # http://127.0.0.1:3000
```

Open that address in the desk PC's browser (kiosk/fullscreen mode works well). The server listens on `127.0.0.1` only. Set `"host": "0.0.0.0"` only if another screen on a trusted LAN needs it.

### Develop without hardware

```bash
npm run start:mock     # emulated PN532 + virtual cards (a "Mock reader" panel appears in the UI)
npm run dev:client     # optional: Vite dev server on :5173 with hot reload, proxies to :3000
npm test               # driver, layout and full HTTP/WebSocket flow tests against the emulator
```

The emulator uses the real frame protocol, so mock mode runs the same driver code as the hardware. From the Mock reader panel you can create, tap and lift cards, and make the next write to a chosen block fail, to test failure handling.

---

## Where things live

```
server/
  src/nfc/card-layout.js     ← block numbers, offsets, encode/decode (edit here if the firmware layout changes)
  src/nfc/pn532.js           ← PN532 HSU frame protocol driver (detect, auth, read, write)
  src/nfc/card-service.js    ← read a whole card; safe ordered write + read-back check
  src/nfc/reader.js          ← connect/reconnect, tap polling, exclusive access
  src/nfc/pn532-emulator.js  ← software PN532 + cards (mock mode, tests)
  src/nfc/nfc-log.js         ← raw frame log → data/logs/nfc-YYYY-MM-DD.log
  src/services/desk.js       ← registration, recharge, tap lookup, uncertain-write reconciliation
  src/services/reports.js    ← all reports (SQL)
  src/db/schema.sql          ← SQLite schema
  src/app.js                 ← REST API + WebSocket
  scripts/nfc-test.js        ← Phase 1 CLI
  scripts/init-db.js
client/src/                  ← React UI (pages/, components/)
```

Only `card-layout.js` knows block numbers and offsets. The driver knows nothing about the layout, and the business logic never touches raw bytes.

**Why a custom PN532 driver:** the npm PN532 packages (`pn532`, `nfc-pn532`) are unmaintained, pin old `serialport` versions that don't build on current Node, and only partly support MIFARE Classic. The six commands needed here are implemented directly from the NXP user manual (UM0701), and the tests check the frames against the manual's examples.

### Data

- `server/data/recharge-station.db` holds all records. **Back it up regularly.** Stop the app before copying it, because the database runs in WAL mode and recent changes may still be in the `-wal` file next to it.
- `server/data/logs/nfc-*.log` holds every PN532 frame and card operation, one line each, for debugging.
- Money is stored as integer **paise** everywhere, and times as UTC. Reports group by the PC's local date.

### Roles

- **Operator:** register and issue cards, recharge, card inquiry, and consumer search (for replacement cards).
- **Admin:** everything an operator can do, plus consumer edits, card block/lost/reactivate, recharge history, all reports, operators, and settings (initial credit, recharge limits, tariff).

### Reports (admin)

Every report is built only from what the desk recorded:
- Card Issue
- Recharge History (shows failed and uncertain attempts too)
- Payment Collection (by payment mode and operator)
- Daily/Monthly Collection Summary
- Consumer Registration
- Meter-wise Recharge
- Cards Not Seen at the Desk: explicitly labelled as based on the *last desk visit*, **not** live meter state

There is no consumption or outstanding-balance report, because the meter never produces that data. Every report exports to CSV and prints.
