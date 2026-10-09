/**
 * Transcript Lens — minify a pasted meeting transcript (Teams / Zoom / Meet).
 *
 * Meeting transcripts are extremely token-heavy: every utterance repeats the
 * speaker name 2-3 times plus a long-form timestamp ("0 minuter 22 sekunder")
 * AND a short clock ("0:22"), separated by blank lines. Typically ~4 lines of
 * boilerplate per 1 line of speech.
 *
 * This lens strips that down to one line per utterance and replaces speaker
 * names with stable IDs (S1, S2, ...). "Who said what" is preserved via the
 * IDs; the id->name legend is returned SEPARATELY so it can be kept private.
 *
 * PRIVACY: real names are never required in the minified body. Emit body with
 * IDs only (anonymised) for sharing; keep the legend somewhere private if you
 * need to resolve names later. Examples/tests here use synthetic names only.
 *
 * Usage:
 *   node lenses/transcript.js --stdin
 *   node cli.js text | node lenses/transcript.js --stdin
 *   node lenses/transcript.js --stdin --legend   (also print id->name legend)
 *
 * Handles Swedish ("N minuter M sekunder") and English ("N minutes M seconds")
 * Teams transcript formats. Language-agnostic for the speech itself.
 */

// "Name  0 minuter 22 sekunder"  /  "Name 0 minutes 22 seconds"
const NAME_TIME = /^(.+?)\s+\d+\s+(?:minuter|minutes?)\s+\d+\s+(?:sekunder|seconds?)\b/;
// A time fragment anywhere: long-form or a clock "0:22" / "12:04"
const CLOCK = /\b(\d{1,2}:\d{2})\b/;
// A line that is ONLY a timestamp (long-form, optionally trailed by a clock)
const TIME_ONLY = /^\d+\s+(?:minuter|minutes?)\s+\d+\s+(?:sekunder|seconds?)(?:\s*\d{1,2}:\d{2})?$/;
// Boilerplate / header noise to drop entirely.
const NOISE = /^(?:\?+|AI-genererat inneh|AI-generated content|.*startade transkriptionen$|.*started transcription$|H[oö]gtalare \d+ startade|Speaker \d+ started)/i;

/**
 * Parse a raw transcript into { speakers, utterances, stats }.
 * @param {string} text raw clipboard text
 * @returns {{speakers: {id:string,name:string}[], utterances: {time:string,speakerId:string,text:string}[], stats: object}}
 */
export function parseTranscript(text) {
  const rawLines = text.split('\n');
  const lines = rawLines.map((l) => l.trim());

  const nameToId = new Map();
  const speakers = [];
  let nextId = 1;

  const idFor = (name) => {
    if (!nameToId.has(name)) {
      const id = 'S' + nextId++;
      nameToId.set(name, id);
      speakers.push({ id, name });
    }
    return nameToId.get(name);
  };

  const utterances = [];
  let current = null; // { speakerId, time, parts: [] }

  const flush = () => {
    if (current && current.parts.length) {
      utterances.push({
        time: current.time || '',
        speakerId: current.speakerId,
        text: current.parts.join(' ').replace(/\s+/g, ' ').trim(),
      });
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (NOISE.test(line)) continue;

    // "Name + time" header -> starts a new utterance block.
    const m = line.match(NAME_TIME);
    if (m) {
      flush();
      const name = m[1].trim();
      const id = idFor(name);
      const time = (line.match(CLOCK) || [])[1] || '';
      current = { speakerId: id, time, parts: [] };
      continue;
    }

    // A bare name line (Teams repeats the name alone right before "name + time").
    // Case 1: it's an already-known speaker name -> duplicate header, skip.
    if (nameToId.has(line)) continue;
    // Case 2: within the next couple of lines there is a "name + time" header
    // starting with this exact name -> this is the lead-in duplicate for a
    // not-yet-seen speaker (Teams prints: name / time / name+time / speech).
    // Skip it; the "name + time" line will register the speaker.
    let lookedAhead = false;
    for (let j = i + 1, seen = 0; j < lines.length && seen < 3; j++) {
      if (!lines[j]) continue;
      seen++;
      const nm = lines[j].match(NAME_TIME);
      if (nm && nm[1].trim() === line) { lookedAhead = true; break; }
      // stop scanning once we hit a line that is neither a pure timestamp nor a name+time
      if (!TIME_ONLY.test(lines[j]) && !nm) break;
    }
    if (lookedAhead) continue;
    // A line that is ONLY a timestamp -> skip.
    if (TIME_ONLY.test(line)) continue;

    // Otherwise it's speech. Attach to the current speaker block.
    if (current) {
      current.parts.push(line);
    } else {
      // Speech before any speaker header — keep it, unattributed.
      utterances.push({ time: '', speakerId: '', text: line });
    }
  }
  flush();

  const rawChars = text.length;
  const body = renderBody({ utterances });
  return {
    type: 'transcript',
    speakers,
    utterances,
    stats: {
      speakers: speakers.length,
      utterances: utterances.length,
      rawChars,
      minifiedChars: body.length,
      reductionPct: rawChars ? Math.round((1 - body.length / rawChars) * 100) : 0,
    },
  };
}

/**
 * Render the minified body — one line per utterance, IDs only (no names).
 * Safe to share: contains no real names.
 */
export function renderBody({ utterances }) {
  const merged = [];
  for (const u of utterances) {
    const last = merged[merged.length - 1];
    // Merge consecutive utterances from the same speaker into one line.
    if (last && last.speakerId === u.speakerId && u.speakerId) {
      last.text += ' ' + u.text;
      if (!last.time) last.time = u.time;
    } else {
      merged.push({ ...u });
    }
  }
  return merged
    .map((u) => `${u.time ? '[' + u.time + '] ' : ''}${u.speakerId ? u.speakerId + ': ' : ''}${u.text}`)
    .join('\n');
}

/** Render the id->name legend. Keep this PRIVATE — it carries real names. */
export function renderLegend({ speakers }) {
  return speakers.map((s) => `${s.id}=${s.name}`).join('  ');
}

// CLI entry point
if (process.argv[1] && /transcript\.js$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const wantLegend = args.includes('--legend');
  const run = (input) => {
    const parsed = parseTranscript(input);
    process.stdout.write(renderBody(parsed) + '\n');
    if (wantLegend) {
      process.stderr.write('\n[legend — private, contains real names]\n' + renderLegend(parsed) + '\n');
    }
    process.stderr.write(`\n[stats] ${parsed.stats.speakers} speakers, ${parsed.stats.utterances} utterances, ` +
      `${parsed.stats.rawChars}->${parsed.stats.minifiedChars} chars (${parsed.stats.reductionPct}% smaller)\n`);
  };

  if (args.includes('--stdin')) {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (input += c));
    process.stdin.on('end', () => run(input));
  } else if (args[0] && !args[0].startsWith('--')) {
    import('fs').then((fs) => run(fs.readFileSync(args[0], 'utf8')));
  } else {
    console.log('Usage: node lenses/transcript.js <file.txt>');
    console.log('       node lenses/transcript.js --stdin [--legend]');
  }
}
