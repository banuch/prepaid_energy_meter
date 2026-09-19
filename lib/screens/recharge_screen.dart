import 'package:flutter/material.dart';

import '../models/card_data.dart';
import '../models/tariff.dart';
import '../services/nfc_service.dart';

class RechargeScreen extends StatefulWidget {
  const RechargeScreen({super.key, required this.card});

  final CardData card;

  @override
  State<RechargeScreen> createState() => _RechargeScreenState();
}

class _RechargeScreenState extends State<RechargeScreen> {
  final _nfcService = NfcService();
  final _amountController = TextEditingController();
  late final _serviceNumberController = TextEditingController(
    text: widget.card.serviceNumber,
  );

  static const _tariff = TariffTable.domesticGroupC;

  bool _writing = false;
  String? _error;

  int get _amountPaise {
    final rupees = double.tryParse(_amountController.text) ?? 0;
    return (rupees * 100).round();
  }

  Future<void> _recharge() async {
    final amountPaise = _amountPaise;
    if (amountPaise <= 0) {
      setState(() => _error = 'Enter a valid recharge amount.');
      return;
    }
    final serviceNumber = _serviceNumberController.text.trim();
    if (serviceNumber.isEmpty) {
      setState(() => _error = 'Enter the service number.');
      return;
    }

    setState(() {
      _writing = true;
      _error = null;
    });

    try {
      final updated = await _nfcService.recharge(
        amountPaise: amountPaise,
        serviceNumber: serviceNumber,
        tariff: _tariff,
      );
      if (!mounted) return;
      Navigator.of(context).pop(updated);
    } catch (e) {
      setState(() {
        _error = e.toString();
        _writing = false;
      });
    }
  }

  void _cancelWrite() {
    _nfcService.cancel();
    setState(() => _writing = false);
  }

  @override
  void dispose() {
    _amountController.dispose();
    _serviceNumberController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final pendingPaise = widget.card.cardAmountPaise;

    return Scaffold(
      appBar: AppBar(title: const Text('Recharge Card')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _serviceNumberController,
              enabled: !_writing,
              decoration: const InputDecoration(
                labelText: 'Service No',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 16),
            if (pendingPaise > 0) ...[
              Card(
                margin: EdgeInsets.zero,
                color: Theme.of(context).colorScheme.errorContainer,
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text(
                    'This card already has an unclaimed ₹${(pendingPaise / 100).toStringAsFixed(2)} '
                    'from a previous recharge. Make sure the meter has read it before you overwrite it — '
                    'writing a new amount discards whatever is currently on the card.',
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.onErrorContainer,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 16),
            ],
            const _TariffCard(tariff: _tariff),
            const SizedBox(height: 16),
            TextField(
              controller: _amountController,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              enabled: !_writing,
              decoration: const InputDecoration(
                labelText: 'Recharge amount (₹)',
                border: OutlineInputBorder(),
              ),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 12),
            Card(
              margin: EdgeInsets.zero,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _SummaryRow(
                      label: 'Amount to write',
                      value: '₹${(_amountPaise / 100).toStringAsFixed(2)}',
                    ),
                    _SummaryRow(
                      label: 'Recharge #',
                      value: '${widget.card.rechargeCount + 1}',
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 32),
            if (_writing) ...[
              const Text(
                'Hold the card near the phone to write the recharge…',
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 16),
              const Center(child: CircularProgressIndicator()),
              const SizedBox(height: 16),
              Center(
                child: TextButton(
                  onPressed: _cancelWrite,
                  child: const Text('Cancel'),
                ),
              ),
            ] else
              FilledButton.icon(
                onPressed: _recharge,
                icon: const Icon(Icons.nfc),
                label: const Text('Write to card'),
              ),
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

/// Read-only reference table — informational only. The meter, not this
/// app, uses these rates to convert consumption into cost.
class _TariffCard extends StatelessWidget {
  const _TariffCard({required this.tariff});

  final TariffTable tariff;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Tariff — Domestic Group C', style: textTheme.titleSmall),
            Text(
              'Applied by the meter to bill consumption, not to this recharge.',
              style: textTheme.bodySmall,
            ),
            const SizedBox(height: 8),
            ...tariff.slabs.map((slab) {
              final range = slab.upperLimitUnits == null
                  ? 'Above'
                  : 'Up to ${slab.upperLimitUnits}';
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('$range units', style: textTheme.bodyMedium),
                    Text(
                      '₹${slab.rateRupees.toStringAsFixed(2)}/unit',
                      style: textTheme.bodyMedium,
                    ),
                  ],
                ),
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
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: Theme.of(context).textTheme.bodyMedium),
          Text(
            value,
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.bold),
          ),
        ],
      ),
    );
  }
}
