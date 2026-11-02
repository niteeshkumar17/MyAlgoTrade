import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCalibratedOptionCandles, expandHourlyToSubBars } from './terminalCandles.js';
import type { Candle } from './types.js';

test('expandHourlyToSubBars preserves bar boundaries and creates 12 five-minute bars per hour', () => {
  const hourly: Candle[] = [
    { time: '2026-11-02T09:15:00+05:30', open: 23200, high: 23310, low: 23180, close: 23285, volume: 120000 },
    { time: '2026-11-02T10:15:00+05:30', open: 23285, high: 23355, low: 23260, close: 23340, volume: 96000 },
  ];
  const sub = expandHourlyToSubBars(hourly, '5m');
  assert.equal(sub.length, 24);
  assert.equal(sub[0].open, 23200);
  assert.equal(sub[11].close, 23285);
  assert.equal(sub[23].close, 23340);
  for (const bar of sub) {
    assert.ok(bar.high >= bar.open && bar.high >= bar.close);
    assert.ok(bar.low <= bar.open && bar.low <= bar.close);
  }
});

test('buildCalibratedOptionCandles scales last close to live option mark', () => {
  const spot: Candle[] = [
    { time: '2026-11-02T09:15:00+05:30', open: 23250, high: 23320, low: 23220, close: 23300, volume: 50000 },
    { time: '2026-11-02T10:15:00+05:30', open: 23300, high: 23370, low: 23290, close: 23350, volume: 60000 },
  ];
  const opt = buildCalibratedOptionCandles(spot, {
    strike: 23350,
    right: 'CE',
    expiry: '2026-11-09',
    targetLastClose: 194.55,
  });
  assert.equal(opt.length, 2);
  assert.equal(opt[1].close, 194.55);
  assert.ok(opt[1].close > opt[0].close);
});
