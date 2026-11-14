import { Gpiod, type Pin } from '../src/gpio';

const pins = process.argv.slice(2) as Pin[];
if (pins.length === 0) throw new Error('usage: bun scripts/gpio_read.ts GPIO1_B6 [GPIO1_B7 ...]');

const gpio = new Gpiod();
try {
  for (const pin of pins) gpio.input(pin, true);
  console.log(JSON.stringify(Object.fromEntries(pins.map(pin => [pin, gpio.read(pin)]))));
} finally {
  gpio.close();
}
