'use strict';
/** Companion mode: when another tool (Claude Code, Codex, Cursor or Copilot CLI) works on the open ask, say so and give its start command. */
const fs = require('node:fs');
const path = require('node:path');
const { BRAND } = require('../brand');
const { record, text } = require('./validate');

const RECENT_MS = 2 * 60 * 60 * 1000;
/** @type {Record<import('./types').Companion['client'], {label: string, start: string}>} */
const TOOLS = {
  claude: { label: 'Claude Code', start: `claude --agent ${BRAND.prefix}-lite` },
  codex: { label: 'Codex', start: `codex, then $${BRAND.prefix}-lite` },
  cursor: { label: 'Cursor', start: `/${BRAND.prefix}-lite in Cursor's Agent chat` },
  copilot: { label: 'Copilot CLI', start: 'copilot, then /agent' },
};

/** Return the tool that last ran hooks for the open ask when it did so in the last two hours and after this window's newest chat, else null.
 * @param {string} workspace
 * @param {import('./types').Chat[]} chats This window's chats, newest first.
 * @param {number} now
 * @returns {import('./types').Companion | null}
 */
function companion(workspace, chats, now) {
  const file = path.join(workspace, BRAND.state_dir, 'runs', 'client.json');
  if (!fs.existsSync(path.join(workspace, BRAND.state_dir, 'asks', 'active.json')) || !fs.existsSync(file)) return null;
  const row = record(JSON.parse(fs.readFileSync(file, 'utf8')), 'Tool record');
  const client = text(row.client, 'Tool');
  const at = text(row.ts, 'Tool record time');
  if (!Object.hasOwn(TOOLS, client) || Number.isNaN(Date.parse(at))) throw new Error(`Invalid tool record in ${file}`);
  if (now - Date.parse(at) > RECENT_MS || (chats[0] && Date.parse(chats[0].lastAt) > Date.parse(at))) return null;
  const tool = TOOLS[/** @type {import('./types').Companion['client']} */ (client)];
  return { client: /** @type {import('./types').Companion['client']} */ (client), label: tool.label, start: tool.start, at };
}

module.exports = { companion, TOOLS };
