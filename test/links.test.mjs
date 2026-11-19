import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeUrl, escHtml } from '../src/links.js';

test('should allow only http, https and mailto links', () => {
  assert.equal(safeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeUrl('mailto:a@b.se'), 'mailto:a@b.se');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'file:///C:/x', '\\\\evil\\share', '//evil/x', 'data:text/html,x', 'https://a b', '', ' ', 'relative/path']) {
    assert.equal(safeUrl(bad), null, bad);
  }
});

test('should escape quotes so text cannot break out of an attribute', () => {
  assert.equal(escHtml(`" onmouseover="x' <b>&`), '&quot; onmouseover=&quot;x&#39; &lt;b&gt;&amp;');
});