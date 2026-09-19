import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:nfc_manager/nfc_manager.dart';
import 'package:nfc_manager/nfc_manager_android.dart';

import '../models/card_data.dart';
import '../models/tariff.dart';

/// Thrown when a discovered tag can't be used as a prepaid energy card.
class NfcException implements Exception {
  NfcException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// Reads/writes the prepaid card: pending recharge amount, recharge
/// history, service number and tariff — and reports the card's memory
/// layout.
///
/// Card layout (MIFARE Classic 1K, factory-default key FF FF FF FF FF FF —
/// swap [defaultKey] once real cards are provisioned with a custom one):
///
/// Sector 1
///  - block 4: pending recharge amount, uint32 BE, paise. NOT a running
///    balance — each recharge overwrites this with just that transaction's
///    amount. The ESP32 meter reads it and adds it to the balance it
///    tracks internally, then is responsible for clearing/updating it.
///  - block 5: recharge meta —
///      bytes 0-3  recharge counter, uint32 BE (increments every recharge)
///      bytes 4-7  last recharge amount, paise, uint32 BE
///      byte  8    billing-cycle year offset from 2020
///      byte  9    billing-cycle month (1-12)
///      bytes 10-13 units consumed so far this billing cycle, uint32 BE
///                  (informational — set by the meter, not by this app)
///      bytes 14-15 reserved
///  - block 6: service number, 16 bytes ASCII, zero-padded
///
/// Sector 2
///  - block 8: tariff header — byte 0 version, byte 1 slab count, rest reserved
///  - block 9: tariff slabs 1-4, 4 bytes each (upperLimit uint16 BE, rate paise uint16 BE)
///  - block 10: tariff slabs 5-8, same format (unused slots are upperLimit=0/rate=0)
class NfcService {
  static const int amountSector = 1;
  static const int amountBlock = 4;
  static const int rechargeMetaBlock = 5;
  static const int serviceNumberBlock = 6;

  static const int tariffSector = 2;
  static const int tariffHeaderBlock = 8;
  static const int tariffSlabBlock1 = 9;
  static const int tariffSlabBlock2 = 10;

  static const int _unboundedSentinel = 0xFFFF;
  static const int _cycleYearBase = 2020;

  static final Uint8List defaultKey = Uint8List.fromList([
    0xFF,
    0xFF,
    0xFF,
    0xFF,
    0xFF,
    0xFF,
  ]);

  Future<NfcAvailability> checkAvailability() {
    return NfcManager.instance.checkAvailability();
  }

  Future<CardData> readCard() async {
    final completer = Completer<CardData>();

    await NfcManager.instance.startSession(
      pollingOptions: {NfcPollingOption.iso14443},
      onDiscovered: (tag) async {
        try {
          final mifare = MifareClassicAndroid.from(tag);
          if (mifare == null) {
            throw NfcException('This is not a MIFARE Classic card.');
          }

          final blocks = await _dumpAllBlocks(mifare);
          completer.complete(_buildCardData(mifare, blocks));
        } catch (e) {
          completer.completeError(e);
        } finally {
          await NfcManager.instance.stopSession();
        }
      },
    );

    return completer.future;
  }

  /// Overwrites the card's pending-amount block with [amountPaise] — this
  /// does NOT read or add to whatever was there before; the ESP32 meter is
  /// the one that accumulates a balance. Also writes the recharge counter,
  /// service number and tariff table back to the card. The billing-cycle
  /// fields are left untouched, since they're maintained by the meter, not
  /// by a recharge.
  Future<CardData> recharge({
    required int amountPaise,
    required String serviceNumber,
    TariffTable tariff = TariffTable.domesticGroupC,
  }) async {
    final completer = Completer<CardData>();

    await NfcManager.instance.startSession(
      pollingOptions: {NfcPollingOption.iso14443},
      onDiscovered: (tag) async {
        try {
          final mifare = MifareClassicAndroid.from(tag);
          if (mifare == null) {
            throw NfcException('This is not a MIFARE Classic card.');
          }

          final before = _buildCardData(mifare, await _dumpAllBlocks(mifare));

          final newCounter = before.rechargeCount + 1;

          final authBalance = await mifare.authenticateSectorWithKeyA(
            sectorIndex: amountSector,
            key: defaultKey,
          );
          if (!authBalance) {
            throw NfcException(
              'Authentication failed for sector $amountSector.',
            );
          }

          await mifare.writeBlock(
            blockIndex: amountBlock,
            data: _encodeUint32(amountPaise),
          );
          await mifare.writeBlock(
            blockIndex: rechargeMetaBlock,
            data: _encodeRechargeMeta(
              counter: newCounter,
              lastAmountPaise: amountPaise,
              cycleYear: before.cycleYear,
              cycleMonth: before.cycleMonth,
              cycleUnitsConsumed: before.cycleUnitsConsumed,
            ),
          );
          await mifare.writeBlock(
            blockIndex: serviceNumberBlock,
            data: _encodeServiceNumber(serviceNumber),
          );

          final authTariff = await mifare.authenticateSectorWithKeyA(
            sectorIndex: tariffSector,
            key: defaultKey,
          );
          if (!authTariff) {
            throw NfcException(
              'Authentication failed for sector $tariffSector.',
            );
          }
          await mifare.writeBlock(
            blockIndex: tariffHeaderBlock,
            data: _encodeTariffHeader(tariff),
          );
          await mifare.writeBlock(
            blockIndex: tariffSlabBlock1,
            data: _encodeTariffSlabs(tariff.slabs, 0),
          );
          await mifare.writeBlock(
            blockIndex: tariffSlabBlock2,
            data: _encodeTariffSlabs(tariff.slabs, 4),
          );

          final after = _buildCardData(mifare, await _dumpAllBlocks(mifare));
          completer.complete(after);
        } catch (e) {
          completer.completeError(e);
        } finally {
          await NfcManager.instance.stopSession();
        }
      },
    );

    return completer.future;
  }

  CardData _buildCardData(MifareClassicAndroid mifare, List<CardBlock> blocks) {
    final tagId = mifare.tag.id
        .map((b) => b.toRadixString(16).padLeft(2, '0'))
        .join(':');

    Uint8List? blockData(int sector, int block) {
      final match = blocks.where(
        (b) => b.sectorIndex == sector && b.blockIndex == block && b.readable,
      );
      return match.isEmpty ? null : match.first.data;
    }

    final balanceData = blockData(amountSector, amountBlock);
    final balance = balanceData == null
        ? 0
        : ByteData.sublistView(balanceData).getUint32(0, Endian.big);

    final metaData = blockData(amountSector, rechargeMetaBlock);
    final meta = ByteData.sublistView(metaData ?? Uint8List(16));
    final rechargeCount = metaData == null ? 0 : meta.getUint32(0, Endian.big);
    final lastAmountPaise = metaData == null
        ? 0
        : meta.getUint32(4, Endian.big);
    final cycleYear = metaData == null || meta.getUint8(8) == 0
        ? 0
        : _cycleYearBase + meta.getUint8(8);
    final cycleMonth = metaData == null ? 0 : meta.getUint8(9);
    final cycleUnitsConsumed = metaData == null
        ? 0
        : meta.getUint32(10, Endian.big);

    final serviceData = blockData(amountSector, serviceNumberBlock);
    final serviceNumber = serviceData == null
        ? ''
        : utf8.decode(serviceData.where((b) => b != 0).toList());

    final headerData = blockData(tariffSector, tariffHeaderBlock);
    final slab1Data = blockData(tariffSector, tariffSlabBlock1);
    final slab2Data = blockData(tariffSector, tariffSlabBlock2);
    final tariff = _decodeTariff(headerData, slab1Data, slab2Data);

    return CardData(
      tagId: tagId,
      cardAmountPaise: balance,
      cardType: _describeCardType(mifare.type, mifare.size),
      totalSizeBytes: mifare.size,
      sectorCount: mifare.sectorCount,
      blockCount: mifare.blockCount,
      blocks: blocks,
      serviceNumber: serviceNumber,
      rechargeCount: rechargeCount,
      lastRechargeAmountPaise: lastAmountPaise,
      cycleYear: cycleYear,
      cycleMonth: cycleMonth,
      cycleUnitsConsumed: cycleUnitsConsumed,
      tariff: tariff ?? TariffTable.domesticGroupC,
    );
  }

  TariffTable? _decodeTariff(
    Uint8List? header,
    Uint8List? slabBlock1,
    Uint8List? slabBlock2,
  ) {
    if (header == null) return null;
    final version = header[0];
    final slabCount = header[1];
    if (version == 0 || slabCount == 0) return null;

    final combined = Uint8List(32)
      ..setRange(0, 16, slabBlock1 ?? Uint8List(16))
      ..setRange(16, 32, slabBlock2 ?? Uint8List(16));
    final view = ByteData.sublistView(combined);

    final slabs = <TariffSlab>[];
    for (var i = 0; i < slabCount && i < 8; i++) {
      final offset = i * 4;
      final limitRaw = view.getUint16(offset, Endian.big);
      final rate = view.getUint16(offset + 2, Endian.big);
      slabs.add(
        TariffSlab(
          upperLimitUnits: limitRaw == _unboundedSentinel ? null : limitRaw,
          ratePaisePerUnit: rate,
        ),
      );
    }
    return TariffTable(version: version, slabs: slabs);
  }

  /// Authenticates every sector and reads every block on the card.
  /// Sectors that fail authentication are reported as locked rather than
  /// aborting the whole read.
  Future<List<CardBlock>> _dumpAllBlocks(MifareClassicAndroid mifare) async {
    final blocks = <CardBlock>[];

    for (var sector = 0; sector < mifare.sectorCount; sector++) {
      final blocksInSector = sector < 32 ? 4 : 16;
      final startBlock = sector < 32 ? sector * 4 : 128 + (sector - 32) * 16;

      var authenticated = false;
      try {
        authenticated = await mifare.authenticateSectorWithKeyA(
          sectorIndex: sector,
          key: defaultKey,
        );
      } catch (_) {
        authenticated = false;
      }

      for (var i = 0; i < blocksInSector; i++) {
        final absoluteBlock = startBlock + i;
        final isTrailer = i == blocksInSector - 1;

        if (!authenticated) {
          blocks.add(
            CardBlock(
              sectorIndex: sector,
              blockIndex: absoluteBlock,
              isTrailer: isTrailer,
              readable: false,
            ),
          );
          continue;
        }

        try {
          final data = await mifare.readBlock(blockIndex: absoluteBlock);
          blocks.add(
            CardBlock(
              sectorIndex: sector,
              blockIndex: absoluteBlock,
              isTrailer: isTrailer,
              readable: true,
              data: isTrailer ? null : data,
            ),
          );
        } catch (_) {
          blocks.add(
            CardBlock(
              sectorIndex: sector,
              blockIndex: absoluteBlock,
              isTrailer: isTrailer,
              readable: false,
            ),
          );
        }
      }
    }

    return blocks;
  }

  String _describeCardType(MifareClassicTypeAndroid type, int sizeBytes) {
    final variant = switch (type) {
      MifareClassicTypeAndroid.classic => 'MIFARE Classic',
      MifareClassicTypeAndroid.plus => 'MIFARE Plus',
      MifareClassicTypeAndroid.pro => 'MIFARE Pro',
      MifareClassicTypeAndroid.unknown => 'Unknown MIFARE',
    };
    final capacity = switch (sizeBytes) {
      320 => 'Mini (320 B)',
      1024 => '1K',
      4096 => '4K',
      _ => '($sizeBytes B)',
    };
    return '$variant $capacity';
  }

  Uint8List _encodeUint32(int value) {
    final block = Uint8List(16);
    ByteData.sublistView(block).setUint32(0, value, Endian.big);
    return block;
  }

  Uint8List _encodeRechargeMeta({
    required int counter,
    required int lastAmountPaise,
    required int cycleYear,
    required int cycleMonth,
    required int cycleUnitsConsumed,
  }) {
    final block = Uint8List(16);
    final view = ByteData.sublistView(block);
    view.setUint32(0, counter, Endian.big);
    view.setUint32(4, lastAmountPaise, Endian.big);
    view.setUint8(8, cycleYear == 0 ? 0 : cycleYear - _cycleYearBase);
    view.setUint8(9, cycleMonth);
    view.setUint32(10, cycleUnitsConsumed, Endian.big);
    return block;
  }

  Uint8List _encodeServiceNumber(String serviceNumber) {
    final block = Uint8List(16);
    final bytes = utf8.encode(serviceNumber);
    final length = bytes.length > 16 ? 16 : bytes.length;
    block.setRange(0, length, bytes.sublist(0, length));
    return block;
  }

  Uint8List _encodeTariffHeader(TariffTable tariff) {
    final block = Uint8List(16);
    block[0] = tariff.version;
    block[1] = tariff.slabs.length;
    return block;
  }

  /// Encodes 4 slabs (16 bytes) starting at [startIndex] within [slabs].
  Uint8List _encodeTariffSlabs(List<TariffSlab> slabs, int startIndex) {
    final block = Uint8List(16);
    final view = ByteData.sublistView(block);
    for (var i = 0; i < 4; i++) {
      final slabIndex = startIndex + i;
      final offset = i * 4;
      if (slabIndex >= slabs.length) continue;
      final slab = slabs[slabIndex];
      view.setUint16(
        offset,
        slab.upperLimitUnits ?? _unboundedSentinel,
        Endian.big,
      );
      view.setUint16(offset + 2, slab.ratePaisePerUnit, Endian.big);
    }
    return block;
  }

  Future<void> cancel() => NfcManager.instance.stopSession();
}
