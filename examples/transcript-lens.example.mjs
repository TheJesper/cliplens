/**
 * Transcript lens — runnable example + smoke test.
 *
 * Uses SYNTHETIC speaker names only (Alice, Bob, Carol). Never put a real
 * meeting transcript here — this is a public repo. The lens replaces names
 * with IDs anyway, but the input itself must stay name-free.
 *
 * Run:  node examples/transcript-lens.example.mjs
 */
import { parseTranscript, renderBody, renderLegend } from '../src/lenses/transcript.js';

// Mimics the Microsoft Teams transcript clipboard shape: a bare name line,
// a bare timestamp line, a "name + time" line, then the speech — separated
// by blank lines, with header noise at the top.
const sample = `
AI-genererat innehåll kan vara felaktigt
Högtalare 1 startade transkriptionen

Alice Example
0 minuter 22 sekunder0:22
Alice Example 0 minuter 22 sekunder
Good morning everyone.

Bob Sample
0 minuter 24 sekunder0:24
Bob Sample 0 minuter 24 sekunder
Hello.
Bob Sample 0 minuter 27 sekunder
Can you hear me?

Alice Example
0 minuter 31 sekunder0:31
Alice Example 0 minuter 31 sekunder
Yes, loud and clear.

Carol Demo
0 minuter 36 sekunder0:36
Carol Demo 0 minuter 36 sekunder
Hi all, ready when you are.
`;

const parsed = parseTranscript(sample);
const body = renderBody(parsed);

console.log('--- MINIFIED BODY (IDs only, safe to share) ---');
console.log(body);
console.log('\n--- LEGEND (private — keep out of public places) ---');
console.log(renderLegend(parsed));
console.log('\n--- STATS ---');
console.log(parsed.stats);

// --- assertions ---
let failed = 0;
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); failed++; } };

assert(parsed.speakers.length === 3, 'expected 3 speakers');
assert(parsed.speakers[0].id === 'S1', 'first speaker id is S1');
assert(!/Alice|Bob|Carol/.test(body), 'body must contain NO real names — IDs only');
assert(/S1: Good morning/.test(body), 'S1 speech mapped correctly');
assert(/S2: Hello\. Can you hear me\?/.test(body), 'consecutive same-speaker lines merged');
assert(parsed.stats.reductionPct >= 60, 'should shrink at least 60%');
assert(renderLegend(parsed).includes('S1=Alice Example'), 'legend resolves id -> name');

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('\n✓ all assertions passed');
