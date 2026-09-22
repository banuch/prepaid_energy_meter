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
