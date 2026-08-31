// gen-sounds.js -- generate 3 short, soft stereo WAVs for opt-in notify sounds.
// Pure Node, no deps. Run: node gen-sounds.js
//
// success  : two-note rising blip (C6 -> E6), gentle
// error    : two-note falling blip (A5 -> E5), soft
// celebrate: three-note arpeggio (C6 -> E6 -> G6), bright but short
//
// All are ~short, low-amplitude, with quick attack + exponential decay so they
// feel like a soft click/chime, not a system alarm.

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SR = 44100;
const AMP = 0.28; // keep it soft

function note(freq, durS, startS, totalS, buf) {
  const start = Math.floor(startS * SR);
  const len = Math.floor(durS * SR);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    // Quick attack (5ms), exponential decay.
    const attack = Math.min(1, t / 0.005);
    const decay = Math.exp(-t * 6.5);
    const env = attack * decay;
    // Sine + soft 2nd harmonic for a slightly richer, bell-ish tone.
    const s = Math.sin(2 * Math.PI * freq * t) * 0.85
            + Math.sin(2 * Math.PI * freq * 2 * t) * 0.15;
    const idx = start + i;
    if (idx < buf.length) buf[idx] += s * env * AMP;
  }
}

function render(notes, totalS) {
  const n = Math.floor(totalS * SR);
  const mono = new Float32Array(n);
  for (const [freq, durS, startS] of notes) note(freq, durS, startS, totalS, mono);
  // Soft-clip to avoid any overshoot.
  for (let i = 0; i < n; i++) mono[i] = Math.tanh(mono[i]);
  return mono;
}

function writeWav(path, mono) {
  const n = mono.length;
  const channels = 2;
  const bytesPerSample = 2;
  const dataLen = n * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(8 * bytesPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, mono[i]));
    const s = (v * 32767) | 0;
    buf.writeInt16LE(s, off); off += 2; // L
    buf.writeInt16LE(s, off); off += 2; // R
  }
  writeFileSync(path, buf);
}

const C6 = 1046.5, E6 = 1318.5, G6 = 1568.0, A5 = 880.0, E5 = 659.3;

const defs = {
  // freq, duration, startTime
  success: { total: 0.42, notes: [[C6, 0.18, 0.0], [E6, 0.30, 0.10]] },
  error: { total: 0.46, notes: [[A5, 0.20, 0.0], [E5, 0.32, 0.12]] },
  celebrate: { total: 0.62, notes: [[C6, 0.16, 0.0], [E6, 0.16, 0.11], [G6, 0.40, 0.22]] },
};

mkdirSync(__dirname, { recursive: true });
for (const [name, d] of Object.entries(defs)) {
  const mono = render(d.notes, d.total);
  const out = join(__dirname, `${name}.wav`);
  writeWav(out, mono);
  console.log('wrote', out);
}
