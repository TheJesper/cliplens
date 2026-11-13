import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendNotify } from '../src/notify.js';

test('should send no popup when a parent process already shows one (CLIPLENS_NO_TOAST=1)', () => {
  const prev = process.env.CLIPLENS_NO_TOAST;
  process.env.CLIPLENS_NO_TOAST = '1';
  try {
    assert.equal(sendNotify({ kind: 'clip', title: 'x' }), 'noop');
  } finally {
    if (prev === undefined) delete process.env.CLIPLENS_NO_TOAST; else process.env.CLIPLENS_NO_TOAST = prev;
  }
});