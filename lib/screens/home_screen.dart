import 'package:flutter/material.dart';
import 'package:nfc_manager/nfc_manager.dart';

import '../models/card_data.dart';
import '../services/nfc_service.dart';
import 'recharge_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _nfcService = NfcService();

  bool _scanning = false;
  CardData? _lastCard;
  String? _error;

  Future<void> _scan() async {
    setState(() {
      _scanning = true;
      _error = null;
    });

    final availability = await _nfcService.checkAvailability();
    if (availability != NfcAvailability.enabled) {
      setState(() {
        _scanning = false;
        _error = switch (availability) {
          NfcAvailability.disabled =>
            'NFC is turned off. Enable it in system settings.',
          NfcAvailability.unsupported => 'This device does not support NFC.',
          NfcAvailability.enabled => null,
        };
      });
      return;
    }

    try {
      final card = await _nfcService.readCard();
      setState(() {
        _lastCard = card;
        _scanning = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _scanning = false;
      });
    }
  }

  void _cancelScan() {
    _nfcService.cancel();
    setState(() => _scanning = false);
  }

  Future<void> _openRecharge() async {
    final card = _lastCard;
    if (card == null) return;

    final updated = await Navigator.of(context).push<CardData>(
      MaterialPageRoute(builder: (_) => RechargeScreen(card: card)),
    );
    if (updated != null) {
      setState(() => _lastCard = updated);
    }
  }

  @override
  Widget build(BuildContext context) {
    final card = _lastCard;

    return Scaffold(
      appBar: AppBar(title: const Text('Prepaid Energy Meter')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: card != null
              ? MainAxisAlignment.start
              : MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Icon(
              _scanning ? Icons.nfc : Icons.credit_card,
              size: card != null ? 48 : 96,
              color: Theme.of(context).colorScheme.primary,
            ),
            SizedBox(height: card != null ? 12 : 24),
            if (_scanning) ...[
              const Text(
                'Hold your card near the back of the phone…',
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 16),
              const CircularProgressIndicator(),
              const SizedBox(height: 16),
              TextButton(onPressed: _cancelScan, child: const Text('Cancel')),
            ] else if (card != null) ...[
              Expanded(child: _CardDetails(card: card)),
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: _openRecharge,
                icon: const Icon(Icons.add_card),
                label: const Text('Recharge card'),
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: _scan,
                icon: const Icon(Icons.refresh),
                label: const Text('Scan again'),
              ),
            ] else ...[
              const Text(
                'Tap the button and hold a card to the phone to read its balance.',
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 24),
              FilledButton.icon(
                onPressed: _scan,
                icon: const Icon(Icons.nfc),
                label: const Text('Scan card'),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 16),
              Text(
                _error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
                textAlign: TextAlign.center,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Shows the card's identity, pending amount, and recharge/tariff summary.
class _CardDetails extends StatelessWidget {
  const _CardDetails({required this.card});

  final CardData card;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Card ID: ${card.tagId}', style: textTheme.bodyMedium),
          const SizedBox(height: 4),
          Text(card.cardType, style: textTheme.bodyMedium),
          if (card.serviceNumber.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              'Service No: ${card.serviceNumber}',
              style: textTheme.bodyMedium,
            ),
          ],
          const SizedBox(height: 8),
          Text(
            '₹${(card.cardAmountPaise / 100).toStringAsFixed(2)}',
            style: textTheme.headlineMedium,
            textAlign: TextAlign.center,
          ),
          Text(
            'Pending amount on card — not your running balance',
            style: textTheme.bodySmall,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 16),
          _AccountSummary(card: card),
        ],
      ),
    );
  }
}

class _AccountSummary extends StatelessWidget {
  const _AccountSummary({required this.card});

  final CardData card;

  @override
  Widget build(BuildContext context) {
    final hasCycle = card.cycleYear != 0;

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Recharge history',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            _MemoryRow(label: 'Recharge count', value: '${card.rechargeCount}'),
            _MemoryRow(
              label: 'Last recharge',
              value:
                  '₹${(card.lastRechargeAmountPaise / 100).toStringAsFixed(2)}',
            ),
            _MemoryRow(
              label: 'Billing cycle',
              value: hasCycle ? '${card.cycleMonth}/${card.cycleYear}' : '—',
            ),
            _MemoryRow(
              label: 'Units this cycle',
              value: '${card.cycleUnitsConsumed}',
            ),
            const SizedBox(height: 12),
            Text(
              'Tariff (v${card.tariff.version})',
              style: Theme.of(context).textTheme.titleSmall,
            ),
            const SizedBox(height: 4),
            ...card.tariff.slabs.map((slab) {
              final range = slab.upperLimitUnits == null
                  ? 'Above'
                  : 'Up to ${slab.upperLimitUnits}';
              return _MemoryRow(
                label: '$range units',
                value: '₹${slab.rateRupees.toStringAsFixed(2)}/unit',
              );
            }),
          ],
        ),
      ),
    );
  }
}

class _MemoryRow extends StatelessWidget {
  const _MemoryRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: Theme.of(context).textTheme.bodyMedium),
          Text(value, style: Theme.of(context).textTheme.bodyMedium),
        ],
      ),
    );
  }
}
