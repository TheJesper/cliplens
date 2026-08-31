#!/usr/bin/env node
/**
 * ClipLens MCP Server
 * 
 * Exposes clipboard capture, inspection, and lens tools to any MCP-capable agent.
 * 
 * Run:   node src/mcp-server.js          (stdio transport)
 * Config: Add to ~/.kiro/settings/mcp.json under "cliplens"
 * 
 * Tools:
 *   cliplens_capture   — Capture full clipboard snapshot (all formats)
 *   cliplens_text      — Get clipboard as plain text
 *   cliplens_formats   — List available clipboard formats
 *   cliplens_inspect   — Inspect a specific format from last capture
 *   cliplens_lens      — Apply a lens (figma, mural) to clipboard content
 *   cliplens_write     — Write text to clipboard
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { captureSnapshot, captureText, listFormats, captureFormat, writeText } from './clipboard.js';
import { parseFigmaText } from './lenses/figma.js';
import { parseMuralHtml } from './lenses/mural.js';
import { sendNotify } from './notify.js';
import { appendHistory, latestByAgent, getById } from './history.js';
import { replay } from './replay.js';
import { penImage } from './pens/image.js';
import { drawDiagram } from './pens/draw.js';

// Keep last capture in memory for inspect
let lastSnapshot = null;

/**
 * Auto-detect clipboard source app from available formats and content.
 * Returns: { app: string, confidence: 'high'|'medium'|'low', signals: string[] }
 */
function detectClipSource(formats, text) {
  const signals = [];
  const formatNames = formats.map(f => f.name || f);

  // Figma detection
  if (formatNames.some(f => /figma/i.test(f))) {
    signals.push('format:figma');
    return { app: 'figma', confidence: 'high', signals };
  }
  // Figma via Chromium source URL
  const urlFormat = formats.find(f => f.name === 'Chromium internal source URL');
  if (urlFormat) {
    const url = urlFormat.preview || '';
    if (/figma\.com/i.test(url)) {
      signals.push('url:figma.com');
      return { app: 'figma', confidence: 'high', signals };
    }
    if (/mural\.co/i.test(url)) {
      signals.push('url:mural.co');
      return { app: 'mural', confidence: 'high', signals };
    }
    if (/miro\.com/i.test(url)) {
      signals.push('url:miro.com');
      return { app: 'miro', confidence: 'high', signals };
    }
  }

  // Mural detection
  if (formatNames.some(f => /mural/i.test(f)) || formatNames.some(f => /x-mural/i.test(f))) {
    signals.push('format:mural');
    return { app: 'mural', confidence: 'high', signals };
  }

  // HTML content sniffing
  const htmlFormat = formats.find(f => f.name === 'HTML Format');
  if (htmlFormat && htmlFormat.preview) {
    if (/murally/i.test(htmlFormat.preview)) {
      signals.push('html:murally-tag');
      return { app: 'mural', confidence: 'high', signals };
    }
    if (/figma/i.test(htmlFormat.preview)) {
      signals.push('html:figma-ref');
      return { app: 'figma', confidence: 'medium', signals };
    }
  }

  // Slack detection
  if (formatNames.some(f => /slack/i.test(f))) {
    signals.push('format:slack');
    return { app: 'slack', confidence: 'high', signals };
  }
  if (htmlFormat && htmlFormat.preview && /slack-/i.test(htmlFormat.preview)) {
    signals.push('html:slack-class');
    return { app: 'slack', confidence: 'medium', signals };
  }

  // Figma heuristic: lots of repeated lines (layer names + text), UI terms
  if (text) {
    const lines = text.split('\n');
    const duplicates = lines.filter((l, i) => lines.indexOf(l) !== i).length;
    const uiTerms = ['Collapsed', 'Expanded', 'Default', 'Hover', 'Active', 'Disabled'];
    const hasStates = uiTerms.some(t => lines.includes(t));
    if (duplicates > lines.length * 0.3 && hasStates) {
      signals.push('heuristic:many-duplicates', 'heuristic:ui-states');
      return { app: 'figma', confidence: 'medium', signals };
    }
    if (duplicates > lines.length * 0.3 && htmlFormat && htmlFormat.sizeBytes > 50000) {
      signals.push('heuristic:many-duplicates', 'heuristic:large-html');
      return { app: 'figma', confidence: 'low', signals };
    }
  }

  signals.push('no-match');
  return { app: 'unknown', confidence: 'low', signals };
}

const server = new Server(
  { name: 'cliplens', version: '0.2.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'cliplens_capture',
      description: 'Capture full clipboard snapshot (all formats). Returns format list with sizes and classifications. Use --app hint for better parsing.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'App hint: figma, mural, miro, slack, unknown', default: 'unknown' },
        },
      },
    },
    {
      name: 'cliplens_text',
      description: 'Get current clipboard content as plain text.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'cliplens_formats',
      description: 'List all clipboard formats currently available (e.g. HTML Format, UnicodeText, application/x-mural, etc.)',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'cliplens_inspect',
      description: 'Inspect a specific format from the last capture. Returns decoded content (text) or base64 (binary).',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', description: 'Format name to inspect (e.g. "HTML Format", "UnicodeText")' },
        },
        required: ['format'],
      },
    },
    {
      name: 'cliplens_lens',
      description: 'Apply a lens to current clipboard text to extract structured data. Available lenses: figma (UI spec extraction), mural (sticky note detection). Returns structured JSON.',
      inputSchema: {
        type: 'object',
        properties: {
          lens: { type: 'string', description: 'Lens to apply: figma, mural', enum: ['figma', 'mural'] },
        },
        required: ['lens'],
      },
    },
    {
      name: 'cliplens_write_plaintext',
      description: 'Write UNFORMATTED plain text to clipboard. WARNING: This gives raw text only — Slack/apps will NOT render any bold/italic/code. For Slack-formatted paste, use cliplens_write_slack instead. Pass `agent` so /redo can recall this clip by sender.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Plain text to write (no formatting will be applied)' },
          agent: { type: 'string', description: "Sending agent name (e.g. 'pp', 'main'). Stored in history so cliplens_redo can recall this clip by sender. Falls back to CLIPLENS_AGENT env." },
        },
        required: ['text'],
      },
    },
    {
      name: 'cliplens_save_image',
      description: 'Save clipboard image to a temp file and return the path. Use when clipboard contains a screenshot/image (formats: Bitmap, PNG, DeviceIndependentBitmap). Returns the file path so you can read_file on it.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'cliplens_write_slack',
      description: 'Write FORMATTED text to clipboard for Slack paste. Converts markdown to native Slack rich text (Quill Delta). Use **bold**, *italic*, `code`, [link](url), :emoji:, - bullets, 1. numbered, ```code blocks```. After calling, tell user to Ctrl+V in Slack. Pass `agent` so /redo can recall this clip by sender.',
      inputSchema: {
        type: 'object',
        properties: {
          markdown: { type: 'string', description: 'Markdown-formatted text to convert to Slack rich text. Supports: **bold**, *italic*, `code`, [text](url), :emoji:, - bullets, 1. numbered lists, ```fenced code blocks```' },
          agent: { type: 'string', description: "Sending agent name (e.g. 'pp', 'main'). Stored in history so cliplens_redo can recall this clip by sender. Falls back to CLIPLENS_AGENT env." },
        },
        required: ['markdown'],
      },
    },
    {
      name: 'cliplens_analyze',
      description: 'Auto-detect clipboard source (figma/mural/slack/unknown) and apply the matching lens. Returns structured data with source detection info. Use this as the default — no need to specify which app.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'cliplens_outlook',
      description: 'Parse Outlook Web clipboard (multi-mail selection) into structured summary. Extracts subjects, JIRA keys, action items, and categories without reading mail bodies.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'cliplens_notify',
      description: "Show a desktop notification card on the user's ACTIVE screen (the monitor under the cursor). VISUAL-FIRST: the card alone conveys the message; sound is OFF unless the user opted in. Use to tell the user something when they may not be watching chat: task done, build broke, you're blocked and need a decision, or a long op finished. Prefer the `kind` field over manual styling — it sets emoji, color and duration. ALWAYS set `agent` so the user sees who is talking. Keep title short (<40 chars) and subtitle to one glanceable line. Use `celebrate` only for real wins (release/PR merged/milestone). Reuse the same `id` to update a progress card in place. Fire-and-forget: returns immediately, never blocks.",
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Main line. Short, glanceable. <40 chars ideal.' },
          subtitle: { type: 'string', description: 'Optional second line, dim. One line, shown verbatim.' },
          agent: { type: 'string', description: "Sending agent name (e.g. 'pp', 'main', 'review'). ALWAYS set it — shown as a small badge. Falls back to CLIPLENS_AGENT env." },
          kind: { type: 'string', enum: ['success', 'error', 'warning', 'info', 'question', 'progress', 'clip', 'celebrate'], description: 'Semantic intent. Sets emoji/color/duration defaults. Default: info.' },
          emoji: { type: 'string', description: "Override the kind's emoji. Single glyph." },
          accent: { type: 'string', description: 'Override accent color as hex (e.g. "#30D158").' },
          sound: { type: 'string', description: "Opt-in sound: 'success'|'error'|'celebrate', a .wav/.mp3 path, or 'off'. Default 'off' (visual-only)." },
          position: { type: 'string', enum: ['bottom', 'center', 'top-right', 'top-left', 'bottom-left', 'bottom-right'], description: 'Screen anchor. Default bottom.' },
          size: { type: 'string', enum: ['small', 'normal', 'large'], description: 'Card size preset. Default derives from kind (clip=small, celebrate=large, else normal).' },
          width: { type: 'number', description: 'Explicit card width in px. Overrides size width. Clamped 260-720.' },
          height: { type: 'number', description: 'Explicit card height in px. Overrides size height. Clamped 72-320.' },
          scale: { type: 'number', description: 'Uniform scale multiplier (emoji + text + padding). 0.8-1.6. Default 1.0.' },
          offset: { type: 'string', description: "Nudge from the anchor as 'x,y' px (e.g. '0,-40' = 40px up)." },
          duration: { type: 'number', description: 'Milliseconds on screen. Overrides the kind default.' },
          id: { type: 'string', description: 'Stable id: re-notifying with the same id updates the existing card in place instead of stacking.' },
        },
        required: ['title'],
      },
    },
    {
      name: 'cliplens_reclip',
      description: "Re-clip the LAST thing (or a specific clip by id) to the clipboard, EXACTLY, no regeneration — any format (plain, slack, html, mural, image). Every clip tool returns a clip id; pass that same id here to get that exact clip back. Omit id to re-clip the most recent (optionally filtered by agent). After calling, tell the user to Ctrl+V.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Clip id returned when the clip was created. Same id in = same clip out.' },
          agent: { type: 'string', description: "Fallback when no id: re-clip this sender's latest clip. Omit for most recent overall." },
        },
      },
    },
    {
      name: 'cliplens_pen_image',
      description: "Put a real image on the clipboard (transparency preserved) so any app pastes it as an image — Mural, Slack, Teams, Word. Use for icons/screenshots/diagrams. Provide an absolute file path. FatCow icons: pass a name (e.g. 'save', 'folder') to auto-resolve from the FatCow set. After calling, tell the user to Ctrl+V.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to an image file (.png etc.). Mutually exclusive with icon.' },
          icon: { type: 'string', description: "FatCow icon name (e.g. 'save', 'folder', 'accept'). Resolved to the icon PNG." },
          size: { type: 'string', enum: ['16', '32'], description: 'FatCow icon size when using `icon`. Default 32.' },
          agent: { type: 'string', description: 'Sender agent for history (badge/redo). Falls back to CLIPLENS_AGENT env.' },
        },
      },
    },
    {
      name: 'cliplens_draw',
      description: "Draw an architecture / flow diagram to the clipboard as NATIVE Mural widgets (shapes + connectors), then the user pastes into Mural with Ctrl+V. Describe the diagram logically as nodes + edges; the pen auto-lays-out and routes connectors. Shapes: box, rounded, process, database/store, decision, service, actor/circle. Layouts: flow-lr (default), flow-tb, grid. After calling, tell the user to Ctrl+V in Mural.",
      inputSchema: {
        type: 'object',
        properties: {
          nodes: {
            type: 'array',
            description: 'Diagram nodes.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique node id (referenced by edges).' },
                label: { type: 'string', description: 'Text shown in the shape.' },
                shape: { type: 'string', description: 'box | rounded | process | database | decision | service | actor | circle. Default box.' },
                color: { type: 'string', description: 'Fill color hex (optional).' },
              },
              required: ['id'],
            },
          },
          edges: {
            type: 'array',
            description: 'Connections between nodes.',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string', description: 'Source node id.' },
                to: { type: 'string', description: 'Target node id.' },
                label: { type: 'string', description: 'Optional edge label.' },
              },
              required: ['from', 'to'],
            },
          },
          layout: { type: 'string', enum: ['flow-lr', 'flow-tb', 'grid'], description: 'Layout strategy. Default flow-lr.' },
          agent: { type: 'string', description: 'Sender agent for history. Falls back to CLIPLENS_AGENT env.' },
        },
        required: ['nodes'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'cliplens_capture': {
      const app = args?.app || 'unknown';
      lastSnapshot = await captureSnapshot(app);
      const summary = lastSnapshot.formats.map(f => 
        `${f.classification.padEnd(10)} ${f.name} (${f.sizeBytes} bytes)`
      ).join('\n');
      return {
        content: [{
          type: 'text',
          text: `Captured ${lastSnapshot.formats.length} formats (app: ${app})\n\n${summary}`,
        }],
      };
    }

    case 'cliplens_text': {
      const text = await captureText();
      return { content: [{ type: 'text', text }] };
    }

    case 'cliplens_formats': {
      const formats = await listFormats();
      return { content: [{ type: 'text', text: formats.join('\n') }] };
    }

    case 'cliplens_inspect': {
      const formatName = args.format;
      if (!lastSnapshot) {
        // Do a quick capture first
        lastSnapshot = await captureSnapshot('unknown');
      }
      const fmt = lastSnapshot.formats.find(f => f.name === formatName);
      if (!fmt) {
        return {
          content: [{ type: 'text', text: `Format "${formatName}" not found. Available: ${lastSnapshot.formats.map(f => f.name).join(', ')}` }],
        };
      }
      let content;
      if (fmt.classification === 'binary') {
        content = `[binary, ${fmt.sizeBytes} bytes, base64]: ${fmt.rawBase64?.substring(0, 500)}...`;
      } else {
        const decoded = Buffer.from(fmt.rawBase64, 'base64').toString('utf-8');
        content = decoded.length > 5000 ? decoded.substring(0, 5000) + '\n...[truncated]' : decoded;
      }
      return { content: [{ type: 'text', text: content }] };
    }

    case 'cliplens_lens': {
      const lens = args.lens;
      const text = await captureText();

      if (lens === 'figma') {
        const result = parseFigmaText(text);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (lens === 'mural') {
        // Read the HTML Format clipboard and decode the real mly:// payload.
        let html = '';
        try {
          const b64 = await captureFormat('HTML Format');
          html = Buffer.from(b64, 'base64').toString('utf-8');
        } catch { /* no HTML format */ }
        const parsed = parseMuralHtml(html);
        return { content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }] };
      }

      return { content: [{ type: 'text', text: `Unknown lens: ${lens}. Available: figma, mural` }] };
    }

    case 'cliplens_save_image': {
      const { writeFileSync, unlinkSync } = await import('fs');
      const { execSync } = await import('child_process');
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      const outPath = join(import.meta.dirname, '..', 'tmp', 'clip-image.png');
      const ps = join(tmpdir(), 'save-clip-img.ps1');
      writeFileSync(ps, `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img) {
  $img.Save('${outPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host "$($img.Width)x$($img.Height)"
} else {
  Write-Host "NO_IMAGE"
}
`);
      const result = execSync(`powershell -ExecutionPolicy Bypass -STA -File "${ps}"`, { encoding: 'utf-8' }).trim();
      unlinkSync(ps);
      if (result === 'NO_IMAGE') {
        return { content: [{ type: 'text', text: 'No image in clipboard. Use cliplens_formats to check what formats are available.' }] };
      }
      sendNotify({ kind: 'info', emoji: '\u{1F5BC}\u{FE0F}', title: 'Bild hämtad', subtitle: `${result} px`, agent: process.env.CLIPLENS_AGENT || 'cliplens' });
      return { content: [{ type: 'text', text: `Image saved: ${outPath} (${result} px). Use read_file to view it.` }] };
    }

    case 'cliplens_write_plaintext': {
      const agent = (args.agent || process.env.CLIPLENS_AGENT || 'cliplens');
      await writeText(args.text);
      const clipId = appendHistory({ text: args.text, format: 'plain', agent });
      sendNotify({ kind: 'clip', format: 'Normal', title: 'Text klar', subtitle: `${args.text.length} tecken`, agent });
      return { content: [{ type: 'text', text: `Written ${args.text.length} chars as PLAIN TEXT to clipboard. clipId=${clipId} (reclip with this id for the exact same clip). Note: no formatting — for Slack formatting use cliplens_write_slack.` }] };
    }

    case 'cliplens_write_slack': {
      const { writeFileSync, unlinkSync } = await import('fs');
      const { execSync } = await import('child_process');
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      const tmpMd = join(tmpdir(), 'cliplens-slack.md');
      writeFileSync(tmpMd, args.markdown, 'utf-8');
      try {
        execSync(`node "${join(import.meta.dirname, 'slack-clip.js')}" --file "${tmpMd}"`, { encoding: 'utf-8' });
        unlinkSync(tmpMd);
        const agent = (args.agent || process.env.CLIPLENS_AGENT || 'cliplens');
        const clipId = appendHistory({ text: args.markdown, format: 'slack', agent });
        sendNotify({ kind: 'clip', format: 'Slack', title: 'Slack-clip klar', subtitle: 'Ctrl+V i Slack', agent });
        return { content: [{ type: 'text', text: `✅ Slack-formatted clipboard ready (${args.markdown.length} chars). clipId=${clipId} (reclip with this id for the exact same clip). Tell user to Ctrl+V in Slack.` }] };
      } catch (e) {
        unlinkSync(tmpMd);
        return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
      }
    }

    // Legacy alias
    case 'cliplens_write': {
      await writeText(args.text);
      return { content: [{ type: 'text', text: `Written ${args.text.length} chars as plain text. WARNING: For Slack formatting use cliplens_write_slack instead!` }] };
    }

    case 'cliplens_analyze': {
      // Capture snapshot for format detection
      lastSnapshot = await captureSnapshot('auto');
      const clipText = await captureText();
      const detection = detectClipSource(lastSnapshot.formats, clipText);

      let analysis;
      if (detection.app === 'figma') {
        analysis = parseFigmaText(clipText);
      } else if (detection.app === 'mural') {
        let html = '';
        try {
          const b64 = await captureFormat('HTML Format');
          html = Buffer.from(b64, 'base64').toString('utf-8');
        } catch { /* no HTML format */ }
        analysis = parseMuralHtml(html);
      } else {
        analysis = { type: 'raw-text', text: clipText.substring(0, 3000) };
      }

      const result = {
        detection,
        formats_count: lastSnapshot.formats.length,
        analysis,
      };

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'cliplens_outlook': {
      const { execSync: exec } = await import('child_process');
      const { readFileSync, existsSync } = await import('fs');
      const { join: pjoin } = await import('path');
      const scriptPath = pjoin(import.meta.dirname, 'outlook-lens.js');
      const outputPath = pjoin(import.meta.dirname, '..', 'tmp', 'email-summary.txt');
      try {
        exec(`node "${scriptPath}"`, { encoding: 'utf-8', timeout: 15000 });
        if (existsSync(outputPath)) {
          const content = readFileSync(outputPath, 'utf-8');
          return { content: [{ type: 'text', text: content }] };
        }
        return { content: [{ type: 'text', text: 'Script ran but no output file was generated.' }] };
      } catch (e) {
        const msg = e.stderr || e.stdout || e.message;
        return { content: [{ type: 'text', text: `Outlook lens error: ${msg}` }] };
      }
    }

    case 'cliplens_notify': {
      const a = args || {};
      if (!a.title || !String(a.title).trim()) {
        return { content: [{ type: 'text', text: 'Error: `title` is required.' }] };
      }
      const delivered = sendNotify({
        title: a.title,
        subtitle: a.subtitle,
        agent: a.agent,
        kind: a.kind,
        emoji: a.emoji,
        accent: a.accent,
        sound: a.sound ?? 'off',
        position: a.position,
        size: a.size,
        width: a.width,
        height: a.height,
        scale: a.scale,
        offset: a.offset,
        duration: a.duration,
        id: a.id,
      });
      const kind = a.kind || 'info';
      const soundNote = (a.sound && a.sound !== 'off') ? ` sound=${a.sound}` : ' (silent)';
      return {
        content: [{
          type: 'text',
          text: `🔔 Notification sent (kind=${kind}, delivered=${delivered}${soundNote}). Shows on the screen under the cursor.`,
        }],
      };
    }

    case 'cliplens_redo': {
      const a = args || {};
      const entry = latestByAgent(a.agent || '');
      if (!entry) {
        return { content: [{ type: 'text', text: 'No clip history yet — nothing to redo.' }] };
      }
      const { writeFileSync, unlinkSync } = await import('fs');
      const { execSync } = await import('child_process');
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      const fmt = entry.format || 'plain';
      const who = entry.agent || 'unknown';
      try {
        if (fmt === 'slack') {
          const tmpMd = join(tmpdir(), 'cliplens-redo-slack.md');
          writeFileSync(tmpMd, entry.text, 'utf-8');
          execSync(`node "${join(import.meta.dirname, 'slack-clip.js')}" --file "${tmpMd}"`, { encoding: 'utf-8' });
          unlinkSync(tmpMd);
        } else if (fmt === 'html') {
          const tmpMd = join(tmpdir(), 'cliplens-redo-html.md');
          writeFileSync(tmpMd, entry.text, 'utf-8');
          execSync(`node "${join(import.meta.dirname, 'html-clip.js')}" --file "${tmpMd}"`, { encoding: 'utf-8' });
          unlinkSync(tmpMd);
        } else {
          await writeText(entry.text);
        }
        // Re-notify so the user gets the same visual confirmation.
        sendNotify({ kind: 'clip', title: 'Clip återställd', subtitle: `${fmt} • Ctrl+V`, agent: who });
        const preview = entry.text.replace(/\s+/g, ' ').trim().slice(0, 60);
        const label = a.agent ? `${who}'s latest ${fmt} clip` : `latest ${fmt} clip (${who})`;
        return { content: [{ type: 'text', text: `♻️ Recalled ${label} — re-encoded to clipboard, no regeneration. Ctrl+V now.\n\n"${preview}${entry.text.length > 60 ? '…' : ''}"` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Redo error: ${e.message}` }] };
      }
    }

    case 'cliplens_reclip': {
      const a = args || {};
      // Priority: explicit id (exact same clip) > agent > most recent overall.
      const entry = a.id ? getById(a.id) : latestByAgent(a.agent || '');
      if (!entry) {
        const why = a.id ? `No clip with id "${a.id}".` : 'No clip history yet — nothing to re-clip.';
        return { content: [{ type: 'text', text: why }] };
      }
      const res = await replay(entry);
      if (!res.ok) {
        return { content: [{ type: 'text', text: `Reclip failed (${res.format}): ${res.detail}` }] };
      }
      const who = entry.agent || 'unknown';
      sendNotify({ kind: 'clip', title: 'Re-clippad', subtitle: `${res.format} • Ctrl+V`, agent: who });
      return { content: [{ type: 'text', text: `♻️ Re-clipped ${res.format} [${entry.id}] — ${res.detail}. Ctrl+V now.` }] };
    }

    case 'cliplens_pen_image': {
      const a = args || {};
      const { existsSync } = await import('fs');
      const { join: pjoin } = await import('path');
      let imagePath = a.path;
      if (!imagePath && a.icon) {
        const size = String(a.size || '32');
        // FatCow icon set location — set CLIPLENS_FATCOW_DIR to the extracted
        // fatcow-master folder (contains 16x16/ and 32x32/ subfolders).
        const fatcowRoot = process.env.CLIPLENS_FATCOW_DIR;
        if (!fatcowRoot) {
          return { content: [{ type: 'text', text: 'Set CLIPLENS_FATCOW_DIR env to your FatCow icon folder to use `icon`, or pass an absolute `path` instead.' }] };
        }
        const candidate = pjoin(fatcowRoot, `${size}x${size}`, `${a.icon}.png`);
        if (existsSync(candidate)) {
          imagePath = candidate;
        } else {
          return { content: [{ type: 'text', text: `FatCow icon "${a.icon}" not found at ${candidate}. Try a different name (e.g. save, folder, accept).` }] };
        }
      }
      if (!imagePath) {
        return { content: [{ type: 'text', text: 'Provide `path` (absolute image file) or `icon` (FatCow name).' }] };
      }
      try {
        const agent = a.agent || process.env.CLIPLENS_AGENT || 'cliplens';
        penImage(imagePath, { record: true, agent });
        sendNotify({ kind: 'info', emoji: '\u{1F5BC}\u{FE0F}', title: 'Bild klar', subtitle: 'Ctrl+V', agent });
        return { content: [{ type: 'text', text: `🖼️ Image on clipboard (transparency preserved): ${imagePath}. Ctrl+V to paste (Mural/Slack/Teams/Word).` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Image pen error: ${e.message}` }] };
      }
    }

    case 'cliplens_draw': {
      const a = args || {};
      if (!a.nodes || !Array.isArray(a.nodes) || a.nodes.length === 0) {
        return { content: [{ type: 'text', text: 'Provide at least one node in `nodes`.' }] };
      }
      const agent = a.agent || process.env.CLIPLENS_AGENT || 'cliplens';
      try {
        const res = drawDiagram(
          { nodes: a.nodes, edges: a.edges || [], layout: a.layout || 'flow-lr' },
          { owner: process.env.CLIPLENS_MURAL_OWNER || undefined, agent, record: true }
        );
        sendNotify({ kind: 'clip', emoji: '\u{1F5FA}\u{FE0F}', title: 'Diagram klart', subtitle: `${res.nodes} noder, ${res.edges} pilar • Ctrl+V`, agent });
        return { content: [{ type: 'text', text: `🗺️ Diagram on clipboard: ${res.nodes} nodes, ${res.edges} connectors (${res.count} widgets). Ctrl+V in Mural to paste as native shapes.` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Draw error: ${e.message}` }] };
      }
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
