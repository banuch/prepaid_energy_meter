/// One telescopic pricing tier: units up to [upperLimitUnits] (inclusive,
/// relative to a running monthly total) are billed at [ratePaisePerUnit].
/// A null [upperLimitUnits] means "and above" — the final, unbounded slab.
class TariffSlab {
  const TariffSlab({
    required this.upperLimitUnits,
    required this.ratePaisePerUnit,
  });

  final int? upperLimitUnits;
  final int ratePaisePerUnit;

  double get rateRupees => ratePaisePerUnit / 100;

  Map<String, dynamic> toJson() => {
    'upperLimitUnits': upperLimitUnits,
    'ratePaisePerUnit': ratePaisePerUnit,
  };
}

/// Result of converting a recharge amount into units using staircase
/// (marginal) pricing: cheaper slabs are filled first, then the amount
/// spills into the next slab, and so on.
class RechargeCalculation {
  const RechargeCalculation({
    required this.unitsBought,
    required this.paiseSpent,
    required this.paiseLeftover,
    required this.endingCycleUnits,
  });

  final int unitsBought;
  final int paiseSpent;
  final int paiseLeftover;
  final int endingCycleUnits;
}

/// A set of telescopic slabs, e.g. TSSPDCL Category I Group C (domestic).
class TariffTable {
  const TariffTable({required this.version, required this.slabs});

  /// TSSPDCL Category I – Domestic, Group C (consumption > 225 units/month).
  /// "Above 500 units" is applied flat at ₹9.95/unit with no upper bound.
  static const TariffTable domesticGroupC = TariffTable(
    version: 1,
    slabs: [
      TariffSlab(upperLimitUnits: 50, ratePaisePerUnit: 265),
      TariffSlab(upperLimitUnits: 100, ratePaisePerUnit: 335),
      TariffSlab(upperLimitUnits: 200, ratePaisePerUnit: 540),
      TariffSlab(upperLimitUnits: 300, ratePaisePerUnit: 710),
      TariffSlab(upperLimitUnits: 400, ratePaisePerUnit: 795),
      TariffSlab(upperLimitUnits: 500, ratePaisePerUnit: 850),
      TariffSlab(upperLimitUnits: null, ratePaisePerUnit: 995),
    ],
  );

  final int version;
  final List<TariffSlab> slabs;

  Map<String, dynamic> toJson() => {
    'version': version,
    'slabs': slabs.map((s) => s.toJson()).toList(),
  };

  /// Converts [amountPaise] into units, starting from [startUnits] already
  /// consumed in the current billing cycle, using staircase pricing:
  /// the amount fills the slab containing [startUnits] first, then spills
  /// into each following slab at its own rate.
  RechargeCalculation calculateStaircase({
    required int startUnits,
    required int amountPaise,
  }) {
    var position = startUnits;
    var remaining = amountPaise;
    var unitsBought = 0;

    for (final slab in slabs) {
      final ceiling = slab.upperLimitUnits;
      if (ceiling != null && position >= ceiling) continue;
      if (remaining <= 0) break;

      final capacity = ceiling == null ? null : ceiling - position;
      final affordable = remaining ~/ slab.ratePaisePerUnit;
      final unitsFromSlab = capacity == null
          ? affordable
          : (affordable < capacity ? affordable : capacity);

      if (unitsFromSlab <= 0) {
        if (capacity != null && affordable == 0) break;
        continue;
      }

      unitsBought += unitsFromSlab;
      position += unitsFromSlab;
      remaining -= unitsFromSlab * slab.ratePaisePerUnit;
    }

    return RechargeCalculation(
      unitsBought: unitsBought,
      paiseSpent: amountPaise - remaining,
      paiseLeftover: remaining,
      endingCycleUnits: position,
    );
  }
}
