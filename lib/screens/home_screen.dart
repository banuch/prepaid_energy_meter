import 'package:flutter/material.dart';
import 'package:nfc_manager/nfc_manager.dart';

import '../models/card_data.dart';
import '../services/nfc_service.dart';
import '../widgets/nfc_pulse.dart';
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
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(
                    child: AnimatedSwitcher(
                      duration: const Duration(milliseconds: 320),
                      switchInCurve: Curves.easeOut,
                      switchOutCurve: Curves.easeIn,
                      transitionBuilder: (child, animation) => FadeTransition(
                        opacity: animation,
                        child: ScaleTransition(
                          scale: Tween(
                            begin: 0.97,
                            end: 1.0,
                          ).animate(animation),
                          child: child,
                        ),
                      ),
                      child: _scanning
                          ? _ScanningState(onCancel: _cancelScan)
                          : card != null
                          ? _CardState(card: card, onRecharge: _openRecharge, onScanAgain: _scan)
                          : _IdleState(onScan: _scan),
                    ),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 16),
                    _ErrorBanner(message: _error!),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _IdleState extends StatelessWidget {
  const _IdleState({required this.onScan});

  final VoidCallback onScan;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return Column(
      key: const ValueKey('idle'),
      mainAxisAlignment: MainAxisAlignment.center,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Icon(Icons.credit_card, size: 96, color: colorScheme.primary),
        const SizedBox(height: 24),
        Text(
          'Tap the button and hold a card to the phone to read its balance.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyLarge,
        ),
        const SizedBox(height: 24),
        FilledButton.icon(
          onPressed: onScan,
          icon: const Icon(Icons.nfc),
          label: const Text('Scan card'),
        ),
      ],
    );
  }
}

class _ScanningState extends StatelessWidget {
  const _ScanningState({required this.onCancel});

  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    return Column(
      key: const ValueKey('scanning'),
      mainAxisAlignment: MainAxisAlignment.center,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Center(child: NfcPulse()),
        const SizedBox(height: 24),
        Text(
          'Hold your card near the back of the phone…',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyLarge,
        ),
        const SizedBox(height: 24),
        OutlinedButton(onPressed: onCancel, child: const Text('Cancel')),
      ],
    );
  }
}

class _CardState extends StatelessWidget {
  const _CardState({
    required this.card,
    required this.onRecharge,
    required this.onScanAgain,
  });

  final CardData card;
  final VoidCallback onRecharge;
  final VoidCallback onScanAgain;

  @override
  Widget build(BuildContext context) {
    return Column(
      key: const ValueKey('card'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _BalanceCard(card: card),
                const SizedBox(height: 16),
                _AccountSummary(card: card),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        FilledButton.icon(
          onPressed: onRecharge,
          icon: const Icon(Icons.add_card),
          label: const Text('Recharge card'),
        ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: onScanAgain,
          icon: const Icon(Icons.refresh),
          label: const Text('Scan again'),
        ),
      ],
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline, color: colorScheme.onErrorContainer),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              message,
              style: TextStyle(color: colorScheme.onErrorContainer),
            ),
          ),
        ],
      ),
    );
  }
}

/// A card-shaped visual summary of the physical card's identity and
/// pending balance.
class _BalanceCard extends StatelessWidget {
  const _BalanceCard({required this.card});

  final CardData card;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [colorScheme.primary, colorScheme.tertiary],
        ),
        boxShadow: [
          BoxShadow(
            color: colorScheme.primary.withValues(alpha: 0.3),
            blurRadius: 20,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.credit_card, color: colorScheme.onPrimary, size: 20),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  card.cardType,
                  style: textTheme.labelLarge?.copyWith(
                    color: colorScheme.onPrimary,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 20),
          Text(
            '₹${(card.cardAmountPaise / 100).toStringAsFixed(2)}',
            style: textTheme.displaySmall?.copyWith(
              color: colorScheme.onPrimary,
              fontWeight: FontWeight.bold,
            ),
          ),
          Text(
            'Pending amount on card — not your running balance',
            style: textTheme.bodySmall?.copyWith(
              color: colorScheme.onPrimary.withValues(alpha: 0.85),
            ),
          ),
          const SizedBox(height: 16),
          Divider(color: colorScheme.onPrimary.withValues(alpha: 0.25)),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Card ID',
                style: textTheme.bodySmall?.copyWith(
                  color: colorScheme.onPrimary.withValues(alpha: 0.85),
                ),
              ),
              Text(
                card.tagId,
                style: textTheme.bodyMedium?.copyWith(
                  color: colorScheme.onPrimary,
                  fontFamily: 'monospace',
                ),
              ),
            ],
          ),
          if (card.serviceNumber.isNotEmpty) ...[
            const SizedBox(height: 4),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  'Service No',
                  style: textTheme.bodySmall?.copyWith(
                    color: colorScheme.onPrimary.withValues(alpha: 0.85),
                  ),
                ),
                Text(
                  card.serviceNumber,
                  style: textTheme.bodyMedium?.copyWith(
                    color: colorScheme.onPrimary,
                  ),
                ),
              ],
            ),
          ],
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
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Recharge history',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            _SummaryRow(label: 'Recharge count', value: '${card.rechargeCount}'),
            _SummaryRow(
              label: 'Last recharge',
              value:
                  '₹${(card.lastRechargeAmountPaise / 100).toStringAsFixed(2)}',
            ),
            _SummaryRow(
              label: 'Billing cycle',
              value: hasCycle ? '${card.cycleMonth}/${card.cycleYear}' : '—',
            ),
            _SummaryRow(
              label: 'Units this cycle',
              value: '${card.cycleUnitsConsumed}',
            ),
            const SizedBox(height: 16),
            Text(
              'Tariff (v${card.tariff.version})',
              style: Theme.of(context).textTheme.titleSmall,
            ),
            const SizedBox(height: 4),
            ...card.tariff.slabs.map((slab) {
              final range = slab.upperLimitUnits == null
                  ? 'Above'
                  : 'Up to ${slab.upperLimitUnits}';
              return _SummaryRow(
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

class _SummaryRow extends StatelessWidget {
  const _SummaryRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: Theme.of(context).textTheme.bodyMedium),
          Text(
            value,
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}
