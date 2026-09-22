import 'package:flutter/material.dart';

/// A pulsing NFC "radar" animation — concentric rings expanding and fading
/// out of a solid icon — shown while the phone is actively scanning or
/// writing to a card.
class NfcPulse extends StatefulWidget {
  const NfcPulse({super.key, this.icon = Icons.nfc, this.size = 140});

  final IconData icon;
  final double size;

  @override
  State<NfcPulse> createState() => _NfcPulseState();
}

class _NfcPulseState extends State<NfcPulse>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1800),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.primary;

    return SizedBox(
      width: widget.size,
      height: widget.size,
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, child) {
          return Stack(
            alignment: Alignment.center,
            children: [
              for (final delay in const [0.0, 0.33, 0.66])
                _Ring(
                  size: widget.size,
                  progress: (_controller.value + delay) % 1,
                  color: color,
                ),
              child!,
            ],
          );
        },
        child: Container(
          width: widget.size * 0.46,
          height: widget.size * 0.46,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: color,
            boxShadow: [
              BoxShadow(
                color: color.withValues(alpha: 0.35),
                blurRadius: 20,
                spreadRadius: 2,
              ),
            ],
          ),
          child: Icon(
            widget.icon,
            color: Colors.white,
            size: widget.size * 0.24,
          ),
        ),
      ),
    );
  }
}

class _Ring extends StatelessWidget {
  const _Ring({required this.size, required this.progress, required this.color});

  final double size;
  final double progress;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final scale = 0.46 + progress * 0.54;
    final opacity = (1 - progress).clamp(0.0, 1.0);

    return Opacity(
      opacity: opacity,
      child: Transform.scale(
        scale: scale,
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: color, width: 2),
          ),
        ),
      ),
    );
  }
}
