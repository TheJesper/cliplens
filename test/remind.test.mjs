import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhen } from '../src/notify.js';

const NOW = new Date(2026, 8, 22, 10, 0, 0).getTime(); // 2026-09-22 10:00 local

test('should pick todays time when HH:MM is still ahead', () => {
  assert.equal(parseWhen('14:30', NOW), new Date(2026, 8, 22, 14, 30).getTime());
});

test('should roll HH:MM to tomorrow when it has already passed', () => {
  assert.equal(parseWhen('09:00', NOW), new Date(2026, 8, 23, 9, 0).getTime());
});

test('should accept epoch ms and ISO date-times', () => {
  assert.equal(parseWhen(1_800_000_000_000, NOW), 1_800_000_000_000);
  assert.equal(parseWhen('2026-09-23T08:00:00Z', NOW), Date.parse('2026-09-23T08:00:00Z'));
});

test('should reject junk and out-of-range times instead of guessing', () => {
  for (const bad of ['', 'soon', '25:00', '12:60', undefined]) {
    assert.throws(() => parseWhen(bad, NOW), /invalid time/, String(bad));
  }
});