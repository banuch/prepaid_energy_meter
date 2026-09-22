# ESP32 GPIO and hardware audit

Source checked: `firmware/firmware.ino` and every GPIO/API reference under
`firmware/`.

## Pin map

| ESP32 pin | Direction | Peripheral / signal | Firmware behavior | Audit |
|---|---:|---|---|---|
| GPIO27 | Output | PN532 SCK | Remapped hardware SPI clock | OK |
| GPIO34 | Input only | PN532 MISO | Remapped hardware SPI input | OK; GPIO34 is input-only and therefore suitable for MISO |
| GPIO26 | Output | PN532 MOSI | Remapped hardware SPI output | OK |
| GPIO32 | Output | PN532 SS/NSS/CS | Active-low SPI chip select via Adafruit PN532 | OK |
| GPIO21 | Bidirectional | SSD1306 SDA | I2C data, address `0x3C` | OK; add/retain I2C pull-ups as required by the OLED module |
| GPIO22 | Output | SSD1306 SCL | I2C clock | OK |
| GPIO16 | Input | UART2 RX | Receives from PZEM TX at 9600 baud | OK; verify the PZEM adapter's TX logic level is safe for 3.3 V ESP32 input |
| GPIO17 | Output | UART2 TX | Sends to PZEM RX at 9600 baud | OK |
| GPIO13 | Output | Warning LED/buzzer | Active HIGH below Rs 50 | OK; LED needs a resistor, and a buzzer should use a transistor driver if its current is more than a GPIO can safely supply |
| GPIO23 | Output | Relay/contactor input | Active LOW (`RELAY_ACTIVE_HIGH = false`) | OK; boot-safe OFF level is written before output mode is enabled |
| GPIO1 | Output | USB-UART TX0 | Debug log at 115200 baud | Reserved for programming/debug serial |
| GPIO3 | Input | USB-UART RX0 | Debug/programming serial | Reserved for programming/debug serial |

## Findings

- No GPIO number is assigned to more than one peripheral.
- The code explicitly remaps SPI to GPIO27/34/26/32 and starts I2C on
  GPIO21/22, so it does not depend on the default VSPI pin set.
- GPIO34 is input-only, but that is valid for PN532 MISO.
- None of the selected PN532 pins is an ESP32 boot-strapping pin. The comments
  correctly avoid GPIO5 and GPIO12 for the stated reasons.
- Relay polarity is consistent: `false` means active-low, OFF is HIGH, and the
  firmware presets that HIGH latch before calling `pinMode(..., OUTPUT)`.
- Wi-Fi uses the ESP32's internal radio and consumes no external GPIO.
- The SSD1306 reset argument is `-1`, so no display reset GPIO is required.

## Hardware cautions

- All low-voltage modules must share ESP32 GND. Keep mains wiring physically
  isolated from the SELV/logic side.
- Wire the PZEM mains/CT terminals only according to the exact PZEM-004T v3
  variant's manufacturer diagram; variants differ.
- Use the relay module to drive a correctly rated contactor when the load can
  exceed the relay PCB's safe switching rating. Add appropriate fuse/MCB and
  enclosure protection.
- Check whether the PZEM UART adapter outputs 3.3 V or 5 V logic. Add level
  shifting or a divider on PZEM TX -> ESP32 GPIO16 if required.
- Confirm the PN532 board is configured for SPI mode before power-up.

The companion diagram is `docs/hardware-wiring.svg`.
