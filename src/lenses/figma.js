/**
 * Figma Lens — WIP
 * 
 * Extracts structured UI spec data from Figma clipboard content.
 * Figma copies as HTML + plain text when you select frames/components.
 * 
 * Usage:
 *   node cli.js capture --app figma --out snap.json
 *   node lenses/figma.js snap.json
 * 
 * Or pipe from clipboard:
 *   node cli.js text | node lenses/figma.js --stdin
 * 
 * STATUS: WIP — basic text parsing. Agents welcome to extend!
 * 
 * TODO (for agents to pick up):
 * - Parse HTML format for richer structure (colors, fonts, layout hierarchy)
 * - Detect component variants (collapsed/expanded states)
 * - Extract color tokens from HTML styles
 * - Detect spacing/padding from HTML structure
 * - Group related text into logical sections (header, body, footer)
 * - Identify interactive elements (buttons, links, inputs)
 * - Generate component spec from extracted data
 * - Support multiple frames (compare variants side-by-side)
 */

/**
 * Parse raw Figma text clipboard into structured sections
 */
export function parseFigmaText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  
  const sections = [];
  let currentSection = null;

  for (const line of lines) {
    // Detect section headers (repeated text = likely a label)
    // Figma duplicates text when both the layer name and content are selected
    if (isLikelyHeader(line, lines)) {
      if (currentSection) sections.push(currentSection);
      currentSection = { title: line, items: [] };
    } else if (currentSection) {
      currentSection.items.push(classifyItem(line));
    } else {
      if (!currentSection) currentSection = { title: '(root)', items: [] };
      currentSection.items.push(classifyItem(line));
    }
  }
  if (currentSection) sections.push(currentSection);

  return {
    type: 'figma-clipboard',
    sections,
    raw_line_count: lines.length,
    detected_states: detectStates(lines),
    detected_components: detectComponents(lines),
  };
}

/**
 * Classify a text line into a type
 */
function classifyItem(line) {
  // Coordinates
  if (/^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(line)) {
    return { type: 'coordinates', value: line };
  }
  // Address-like
  if (/\b[A-Z]{2}-\d{5}\b/.test(line) || /\d+\.\d+,\s*\d+\.\d+/.test(line)) {
    return { type: 'address', value: line };
  }
  // Price
  if (/SEK|EUR|USD|kWh|\/kW/.test(line)) {
    return { type: 'price', value: line };
  }
  // Availability (e.g. "2/3", "4/4")
  if (/^\d+\/\d+$/.test(line)) {
    return { type: 'availability', value: line };
  }
  // Connector type
  if (/Type \d|MSC|CCS|CHAdeMO/i.test(line)) {
    return { type: 'connector', value: line };
  }
  // Status
  if (/Available|In use|Occupied|Out of order/i.test(line)) {
    return { type: 'status', value: line };
  }
  // EVSE ID
  if (/^[A-Z]{2}\*[A-Z]+\*[A-Z0-9]+/.test(line)) {
    return { type: 'evse_id', value: line };
  }
  // Percentage/discount
  if (/\d+%/.test(line)) {
    return { type: 'percentage', value: line };
  }
  // Secondary text (Figma label)
  if (line === 'Secondary text') {
    return { type: 'placeholder', value: line };
  }
  // Default
  return { type: 'text', value: line };
}

/**
 * Detect if a line is likely a section header
 */
function isLikelyHeader(line, allLines) {
  // Headers often appear multiple times (layer name + text content)
  const count = allLines.filter(l => l === line).length;
  if (count >= 2 && line.length < 30 && !line.includes('|') && !/^\d/.test(line)) {
    return true;
  }
  return false;
}

/**
 * Detect UI states (collapsed, expanded, hover, etc.)
 */
function detectStates(lines) {
  const states = [];
  const stateKeywords = ['Collapsed', 'Expanded', 'Hover', 'Active', 'Disabled', 'Default', 'Selected', 'Error'];
  for (const line of lines) {
    if (stateKeywords.includes(line)) {
      states.push(line);
    }
  }
  return states;
}

/**
 * Detect likely component names from the text
 */
function detectComponents(lines) {
  const components = [];
  const componentPatterns = [
    /^(Button|Card|Modal|Drawer|Panel|Header|Footer|List|Badge|Tag|Chip|Alert|Toast)/i,
    /^(POI details|Connector types|Facilities|Charging location)/i,
  ];
  for (const line of lines) {
    for (const pattern of componentPatterns) {
      if (pattern.test(line) && !components.includes(line)) {
        components.push(line);
      }
    }
  }
  return components;
}

// CLI entry point
if (process.argv[1]?.includes('figma')) {
  import('fs').then(fs => {
    const args = process.argv.slice(2);
    
    if (args[0] === '--stdin') {
      let input = '';
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        console.log(JSON.stringify(parseFigmaText(input), null, 2));
      });
    } else if (args[0]) {
      const snap = JSON.parse(fs.readFileSync(args[0], 'utf-8'));
      const textFormat = snap.formats.find(f => f.name === 'UnicodeText' || f.name === 'Text');
      if (textFormat) {
        const decoded = Buffer.from(textFormat.rawBase64, 'base64').toString('utf-8');
        console.log(JSON.stringify(parseFigmaText(decoded), null, 2));
      } else {
        console.error('No text format found in snapshot');
      }
    } else {
      console.log('Usage: node lenses/figma.js <snapshot.json>');
      console.log('       node lenses/figma.js --stdin');
    }
  });
}
