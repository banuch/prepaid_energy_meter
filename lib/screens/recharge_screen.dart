import 'package:flutter/material.dart';

import '../models/card_data.dart';
import '../models/tariff.dart';
import '../services/nfc_service.dart';
import '../widgets/nfc_pulse.dart';

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
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: AnimatedSwitcher(
                duration: const Duration(milliseconds: 320),
                switchInCurve: Curves.easeOut,
                switchOutCurve: Curves.easeIn,
                transitionBuilder: (child, animation) => FadeTransition(
                  opacity: animation,
                  child: ScaleTransition(
                    scale: Tween(begin: 0.97, end: 1.0).animate(animation),
                    child: child,
                  ),
                ),
                child: _writing
                    ? _WritingState(onCancel: _cancelWrite)
                    : _FormState(
                        serviceNumberController: _serviceNumberController,
                        amountController: _amountController,
                        error: _error,
                        onSubmit: _recharge,
                        onAmountChanged: () => setState(() {}),
                      ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _FormState extends StatelessWidget {
  const _FormState({
    required this.serviceNumberController,
    required this.amountController,
    required this.error,
    required this.onSubmit,
    required this.onAmountChanged,
  });

  final TextEditingController serviceNumberController;
  final TextEditingController amountController;
  final String? error;
  final VoidCallback onSubmit;
  final VoidCallback onAmountChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      key: const ValueKey('form'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: serviceNumberController,
          decoration: const InputDecoration(labelText: 'Service No'),
        ),
        const SizedBox(height: 16),
        TextField(
          controller: amountController,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: const InputDecoration(labelText: 'Recharge amount (₹)'),
          onChanged: (_) => onAmountChanged(),
        ),
        const SizedBox(height: 32),
        FilledButton.icon(
          onPressed: onSubmit,
          icon: const Icon(Icons.nfc),
          label: const Text('Write to card'),
        ),
        if (error != null) ...[
          const SizedBox(height: 16),
          _ErrorBanner(message: error!),
        ],
      ],
    );
  }
}

class _WritingState extends StatelessWidget {
  const _WritingState({required this.onCancel});

  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    return Column(
      key: const ValueKey('writing'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 32),
        const Center(child: NfcPulse(icon: Icons.add_card)),
        const SizedBox(height: 24),
        Text(
          'Hold the card near the phone to write the recharge…',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyLarge,
        ),
        const SizedBox(height: 24),
        OutlinedButton(onPressed: onCancel, child: const Text('Cancel')),
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
