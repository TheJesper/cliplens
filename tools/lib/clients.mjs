/**
 * clients.mjs — the cross-client install matrix for ClipLens.
 *
 * ONE source of truth for WHERE each AI client keeps its MCP config and its
 * skill/rules file, plus WHAT format that config uses. Everything the installer
 * and the update-checker need to touch a client lives here, so when a client
 * changes its convention we edit one row, not five scripts.
 *
 * Researched + verified Feb 2026. Conventions drift — re-verify against each
 * client's docs when something stops working, and update the row here.
 *
 * Format keys:
 *   mcpFormat: 'mcpServers'  -> JSON, servers under { "mcpServers": {...} }   (most clients)
 *              'servers'     -> JSON, servers under { "servers": {...} }      (VS Code Copilot)
 *              'toml'        -> TOML, servers under [mcp_servers.<name>]       (Codex)
 *   skillKind: 'flat-md'     -> <dir>/<name>.md            (Kiro)
 *              'folder'      -> <dir>/<name>/SKILL.md      (Claude Code, Gemini, Codex — SKILL.md standard)
 *              'rules-mdc'   -> <dir>/<name>.mdc           (Cursor rules)
 *              'agents-md'   -> AGENTS.md in a scope root  (open AGENTS.md standard)
 *              null          -> client has no skill surface (e.g. Claude Desktop)
 */

import { homedir, platform } from 'os';
import { join } from 'path';

const HOME = homedir();
const WIN = platform() === 'win32';
const APPDATA = process.env.APPDATA || join(HOME, 'AppData', 'Roaming');
// Kiro honors KIRO_HOME to relocate ~/.kiro.
const KIRO_HOME = process.env.KIRO_HOME || join(HOME, '.kiro');

/**
 * Every supported client. `detect` paths are the fingerprints we check to know
 * the client is installed on this machine (any one existing = present).
 *
 * userMcp   — global MCP config file (all projects)
 * userSkill — global skill/rules destination dir (or file, for agents-md)
 * mcpFormat — how to encode the server entry in userMcp
 * skillKind — how to write the skill file
 */
export const CLIENTS = [
  {
    id: 'kiro',
    label: 'Kiro (IDE + CLI)',
    detect: [KIRO_HOME],
    userMcp: join(KIRO_HOME, 'settings', 'mcp.json'),
    mcpFormat: 'mcpServers',
    userSkill: join(KIRO_HOME, 'skills'),
    skillKind: 'folder',
    workspaceMcp: '.kiro/settings/mcp.json',
    notes: 'IDE and CLI share ~/.kiro. CLI v3 uses versioned agent/hook schemas. Skills are folder-based: skills/<name>/SKILL.md with name+description frontmatter (same layout as Claude Code).',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    detect: [join(HOME, '.claude'), join(HOME, '.claude.json')],
    userMcp: join(HOME, '.claude.json'), // user scope: top-level mcpServers key
    mcpFormat: 'mcpServers',
    userSkill: join(HOME, '.claude', 'skills'),
    skillKind: 'folder',
    workspaceMcp: '.mcp.json',
    notes: 'Prefer `claude mcp add`. ~/.claude.json holds user-scope servers under mcpServers. Skills = folder/SKILL.md (open standard).',
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    detect: WIN
      ? [join(APPDATA, 'Claude')]
      : [join(HOME, 'Library', 'Application Support', 'Claude')],
    userMcp: WIN
      ? join(APPDATA, 'Claude', 'claude_desktop_config.json')
      : join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    mcpFormat: 'mcpServers',
    userSkill: null, // Desktop has no on-disk skill surface
    skillKind: null,
    notes: 'Separate app from Claude Code. No skill file — MCP tools only.',
  },
  {
    id: 'vscode-copilot',
    label: 'VS Code (Copilot agent)',
    detect: WIN
      ? [join(APPDATA, 'Code', 'User')]
      : [join(HOME, 'Library', 'Application Support', 'Code', 'User'), join(HOME, '.config', 'Code', 'User')],
    userMcp: WIN
      ? join(APPDATA, 'Code', 'User', 'mcp.json')
      : (platform() === 'darwin'
          ? join(HOME, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
          : join(HOME, '.config', 'Code', 'User', 'mcp.json')),
    mcpFormat: 'servers', // VS Code uses "servers", NOT "mcpServers"
    userSkill: null,       // Copilot reads instructions/*.md, not a skill folder — handled via AGENTS.md fallback
    skillKind: null,
    workspaceMcp: '.vscode/mcp.json',
    notes: 'KEY IS "servers" not "mcpServers". Workspace file .vscode/mcp.json. Copilot CLI reads ~/.copilot/mcp-config.json separately.',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    detect: [join(HOME, '.cursor')],
    userMcp: join(HOME, '.cursor', 'mcp.json'),
    mcpFormat: 'mcpServers',
    userSkill: join(HOME, '.cursor', 'rules'),
    skillKind: 'rules-mdc',
    workspaceMcp: '.cursor/mcp.json',
    notes: 'Rules live in .cursor/rules/*.mdc with frontmatter. Also reads AGENTS.md and CLAUDE.md. .cursorrules is legacy.',
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    detect: [join(HOME, '.codeium', 'windsurf')],
    userMcp: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
    mcpFormat: 'mcpServers',
    userSkill: null,
    skillKind: null,
    notes: 'Global config only, no env-var interpolation — inline literal values. Rules via .windsurfrules / AGENTS.md.',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    detect: [join(HOME, '.codex')],
    userMcp: join(HOME, '.codex', 'config.toml'),
    mcpFormat: 'toml',
    userSkill: join(HOME, '.codex', 'skills'),
    skillKind: 'folder',
    workspaceMcp: '.codex/config.toml',
    notes: 'TOML, section [mcp_servers.<name>]. Prefer `codex mcp add`. Reads AGENTS.md for context; SKILL.md folders supported.',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    detect: [join(HOME, '.gemini')],
    userMcp: join(HOME, '.gemini', 'settings.json'),
    mcpFormat: 'mcpServers',
    userSkill: join(HOME, '.gemini', 'skills'),
    skillKind: 'folder',
    workspaceMcp: '.gemini/settings.json',
    notes: 'settings.json under mcpServers. Context via GEMINI.md or AGENTS.md. Skills = folder/SKILL.md.',
  },
];

/** Central registry: where ClipLens records what it installed + where the repo lives. */
export const REGISTRY_DIR = join(HOME, '.cliplens');
export const REGISTRY_FILE = join(REGISTRY_DIR, 'install.json');

/** The MCP server entry ClipLens installs (command form). */
export function mcpEntry(repoRoot) {
  return {
    command: 'node',
    args: [join(repoRoot, 'src', 'mcp-server.js')],
    env: {},
    autoApprove: ['cliplens_text', 'cliplens_formats', 'cliplens_capture', 'cliplens_analyze'],
  };
}
