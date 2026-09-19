import 'dart:typed_data';

import 'tariff.dart';

/// One block of memory read from the card.
class CardBlock {
  const CardBlock({
    required this.sectorIndex,
    required this.blockIndex,
    required this.isTrailer,
    required this.readable,
    this.data,
  });

  final int sectorIndex;
  final int blockIndex;
  final bool isTrailer;
  final bool readable;

  /// Raw block bytes, or null if the sector could not be authenticated.
  /// For [isTrailer] blocks this is withheld even when readable, since it
  /// holds the sector's keys.
  final Uint8List? data;

  String get hex {
    if (!readable) return '-- locked --';
    if (isTrailer) return '-- keys hidden --';
    final bytes = data;
    if (bytes == null) return '';
    return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join(' ');
  }

  Map<String, dynamic> toJson() => {
    'sector': sectorIndex,
    'block': blockIndex,
    'isTrailer': isTrailer,
    'readable': readable,
    'hex': hex,
  };
}

class CardData {
  const CardData({
    required this.tagId,
    required this.cardAmountPaise,
    required this.cardType,
    required this.totalSizeBytes,
    required this.sectorCount,
    required this.blockCount,
    required this.blocks,
    required this.serviceNumber,
    required this.rechargeCount,
    required this.lastRechargeAmountPaise,
    required this.cycleYear,
    required this.cycleMonth,
    required this.cycleUnitsConsumed,
    required this.tariff,
  });

  final String tagId;

  /// The most recent recharge amount, in paise, currently sitting on the
  /// card. This is NOT a running balance — the phone never sums it with
  /// past recharges. Each recharge overwrites this with just that
  /// transaction's amount; the ESP32 meter is responsible for reading it
  /// and adding it to the balance it tracks internally.
  final int cardAmountPaise;

  /// e.g. "MIFARE Classic 1K".
  final String cardType;

  /// Total memory capacity of the card, in bytes.
  final int totalSizeBytes;

  final int sectorCount;
  final int blockCount;

  /// Every block on the card, in order, including locked/trailer blocks.
  final List<CardBlock> blocks;

  /// Consumer/meter service number stored on the card.
  final String serviceNumber;

  /// Number of times this card has been recharged (monotonic, never reset).
  final int rechargeCount;

  final int lastRechargeAmountPaise;

  /// Billing-cycle marker for [cycleUnitsConsumed]; 0/0 means never set.
  final int cycleYear;
  final int cycleMonth;

  /// Units consumed so far in the current billing cycle, as tracked by the
  /// meter (informational — this app does not write to it).
  final int cycleUnitsConsumed;

  final TariffTable tariff;

  int get readableBlockCount => blocks.where((b) => b.readable).length;

  /// Mirrors the decoded fields the ESP32 firmware should arrive at when it
  /// parses the same raw blocks (see block layout in [NfcService]'s doc
  /// comment) — use this to cross-check the two readers agree.
  Map<String, dynamic> toJson() => {
    'tagId': tagId,
    'cardType': cardType,
    'totalSizeBytes': totalSizeBytes,
    'sectorCount': sectorCount,
    'blockCount': blockCount,
    'serviceNumber': serviceNumber,
    'cardAmountPaise': cardAmountPaise,
    'rechargeCount': rechargeCount,
    'lastRechargeAmountPaise': lastRechargeAmountPaise,
    'billingCycle': {
      'year': cycleYear,
      'month': cycleMonth,
      'unitsConsumed': cycleUnitsConsumed,
    },
    'tariff': tariff.toJson(),
    'blocks': blocks.map((b) => b.toJson()).toList(),
  };

  CardData copyWith({
    int? cardAmountPaise,
    List<CardBlock>? blocks,
    String? serviceNumber,
    int? rechargeCount,
    int? lastRechargeAmountPaise,
    int? cycleYear,
    int? cycleMonth,
    int? cycleUnitsConsumed,
    TariffTable? tariff,
  }) {
    return CardData(
      tagId: tagId,
      cardAmountPaise: cardAmountPaise ?? this.cardAmountPaise,
      cardType: cardType,
      totalSizeBytes: totalSizeBytes,
      sectorCount: sectorCount,
      blockCount: blockCount,
      blocks: blocks ?? this.blocks,
      serviceNumber: serviceNumber ?? this.serviceNumber,
      rechargeCount: rechargeCount ?? this.rechargeCount,
      lastRechargeAmountPaise:
          lastRechargeAmountPaise ?? this.lastRechargeAmountPaise,
      cycleYear: cycleYear ?? this.cycleYear,
      cycleMonth: cycleMonth ?? this.cycleMonth,
      cycleUnitsConsumed: cycleUnitsConsumed ?? this.cycleUnitsConsumed,
      tariff: tariff ?? this.tariff,
    );
  }
}
