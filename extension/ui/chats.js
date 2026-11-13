'use strict';
/** Index this window's Copilot Chat sessions incrementally and link each one to the asks it created, reopened, edited or was opened for. */
const fs = require('node:fs');
const path = require('node:path');
const { record, text } = require('./validate');
const { describe, headline, status, stillRunning, requested, awaiting } = require('./activity');
const { ASK, askTime } = require('./asks');
const { BRAND } = require('../brand');
const STATE = BRAND.state_dir;
const CHAT_LIMIT = 30;
const CHUNK_BYTES = 4 * 1024 * 1024;
const CREATED_WITHIN_MS = 15 * 60 * 1000;
const PENDING_MS = 60 * 60 * 1000;
const SESSION = /^[\w-]+$/;
const SHELL_TOOLS = new Set(['run_in_terminal', 'powershell', 'bash', 'shell', 'exec_command']);
const CONTRACT = /\bcontract\s+["']?[\w.-]+["']?\s+["']?([a-z0-9][a-z0-9-]{0,40})(?=["'\s;|]|$)/g;
const OPEN = /\bopen\s+["']?(\d{8}-\d{4}-[a-z0-9][a-z0-9-]{0,40})(?=["'\s;|]|$)/g;
const ASK_PATH = new RegExp(`(?:^|[\\\\/])${STATE.replace('.', '\\.')}[\\\\/]asks[\\\\/](\\d{8}-\\d{4}-[a-z0-9][a-z0-9-]{0,40})[\\\\/]`);
const STARTER_ASK = new RegExp(`work in the ask ${STATE.replace('.', '\\.')}/asks/(\\d{8}-\\d{4}-[a-z0-9][a-z0-9-]{0,40})\\b`, 'i');
const HOW = ['started', 'linked', 'continued'];

/** @typedef {{offset: number, size: number, mtime: number, lines: number, id: string, model: string | null, title: string | null, started: string, lastAt: string,
 *   turnOpen: boolean, running: Map<string, {tool: string, at: string}>, requested: Map<string, import('./types').ActivityEvent>,
 *   contracts: {slug: string, at: number}[], opened: Set<string>, edited: Set<string>}} Scan */
/** @type {Map<string, Scan>} */
const scans = new Map();
/** @type {Map<string, {mtime: number, cwd: string | null, gitRoot: string | null, client: string | null}>} */
const copilotWorkspaces = new Map();

/** Normalize a filesystem path for cross-case comparison on Windows.
 * @param {string} value
 * @returns {string}
 */
function normPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Return the session id of a Local transcript (<id>.jsonl) or a Copilot session (<id>/events.jsonl).
 * @param {string} file
 * @returns {string}
 */
function sessionIdOf(file) {
  const base = path.basename(file, '.jsonl');
  return base === 'events' ? path.basename(path.dirname(file)) : base;
}

/** Read a Copilot session-state workspace.yaml (cached by mtime) for its workspace paths and client name.
 * @param {string} yamlFile
 * @returns {{cwd: string | null, gitRoot: string | null, client: string | null}}
 */
function readWorkspaceYaml(yamlFile) {
  const stat = fs.statSync(yamlFile);
  const hit = copilotWorkspaces.get(yamlFile);
  if (hit && hit.mtime === stat.mtimeMs) return hit;
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of fs.readFileSync(yamlFile, 'utf8').split(/\r?\n/)) {
    const match = /^(cwd|git_root|client_name|last_client_name):\s*(.+)$/.exec(line);
    if (match) fields[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  const parsed = { mtime: stat.mtimeMs, cwd: fields.cwd || null, gitRoot: fields.git_root || null,
    client: fields.last_client_name || fields.client_name || null };
  copilotWorkspaces.set(yamlFile, parsed);
  return parsed;
}

/** Return the Copilot session-state events.jsonl files belonging to workspace.
 * @param {string} workspace
 * @param {string | null} [copilotRoot]
 * @returns {{id: string, file: string, mtime: number, size: number, client: string | null}[]}
 */
function copilotFiles(workspace, copilotRoot = null) {
  if (!copilotRoot || !fs.existsSync(copilotRoot)) return [];
  const target = normPath(workspace);
  /** @type {{id: string, file: string, mtime: number, size: number, client: string | null}[]} */
  const found = [];
  for (const entry of fs.readdirSync(copilotRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SESSION.test(entry.name)) continue;
    const yaml = path.join(copilotRoot, entry.name, 'workspace.yaml');
    const events = path.join(copilotRoot, entry.name, 'events.jsonl');
    if (!fs.existsSync(yaml) || !fs.existsSync(events)) continue;
    const info = readWorkspaceYaml(yaml);
    if ((info.cwd && normPath(info.cwd) === target) || (info.gitRoot && normPath(info.gitRoot) === target)) {
      const stat = fs.statSync(events);
      found.push({ id: entry.name, file: events, mtime: stat.mtimeMs, size: stat.size, client: info.client });
    }
  }
  return found;
}

/** Return a compact change stamp of Copilot session files for workspace so visible views refresh only on real changes.
 * @param {string} workspace
 * @param {string | null} [copilotRoot]
 * @returns {string}
 */
function copilotDigest(workspace, copilotRoot = null) {
  return copilotFiles(workspace, copilotRoot).sort((a, b) => b.mtime - a.mtime).slice(0, CHAT_LIMIT)
    .map(row => `${row.id}:${row.size}:${Math.round(row.mtime)}`).join('|');
}

/** Apply one transcript event to a chat's scan.
 * @param {Scan} s
 * @param {Record<string, unknown>} row
 * @param {string} workspace
 * @returns {void}
 */
function apply(s, row, workspace) {
  const type = text(row.type, 'Transcript event type');
  const at = text(row.timestamp, `${type} timestamp`);
  const data = record(row.data, `${type} data`);
  s.started ||= at;
  s.lastAt = at;
  if (type === 'session.start') {
    s.started = text(data.startTime, 'Session start time');
    if (typeof data.selectedModel === 'string' && data.selectedModel) s.model = data.selectedModel;
  } else if (type === 'user.message') {
    s.running.clear();
    s.requested.clear();
    const content = text(data.content, 'Your message', true);
    if (content.trim()) s.title ||= headline(content);
    const starter = STARTER_ASK.exec(content);
    if (starter) s.opened.add(starter[1]);
    if (Array.isArray(data.attachments)) {
      for (const item of data.attachments) {
        const file = item && typeof item === 'object' && typeof /** @type {Record<string, unknown>} */ (item).path === 'string'
          ? /** @type {string} */ (/** @type {Record<string, unknown>} */ (item).path) : '';
        const match = ASK_PATH.exec(file);
        if (match) s.opened.add(match[1]);
      }
    }
  } else if (type === 'assistant.turn_start') s.turnOpen = true;
  else if (type === 'assistant.turn_end') s.turnOpen = false;
  else if (type === 'abort') { s.turnOpen = false; s.running.clear(); s.requested.clear(); }
  else if (type === 'assistant.message') {
    s.running.clear();
    if (typeof data.model === 'string' && data.model) s.model = data.model;
    s.requested = requested(data, workspace, at);
  } else if (type === 'tool.execution_start') {
    const tool = text(data.toolName, 'Tool name');
    s.requested.delete(text(data.toolCallId, 'Tool call id'));
    const rawArgs = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments;
    const args = rawArgs === undefined ? {} : record(rawArgs, `${tool} arguments`);
    s.running.set(text(data.toolCallId, 'Tool call id'), { tool, at });
    const command = SHELL_TOOLS.has(tool) && typeof args.command === 'string' ? args.command : '';
    if (/lifecycle\.py/.test(command)) {
      for (const match of command.matchAll(CONTRACT)) s.contracts.push({ slug: match[1], at: Date.parse(at) });
      for (const match of command.matchAll(OPEN)) s.opened.add(match[1]);
    }
    const event = describe(tool, args, workspace, at);
    if (event.kind === 'edit') for (const file of event.files) {
      const match = ASK_PATH.exec(file);
      if (match) s.edited.add(match[1]);
    }
  } else if (type === 'tool.execution_complete') s.running.delete(text(data.toolCallId, 'Tool call id'));
}

/** Return a transcript's scan, reading only the complete lines added since the last call.
 * @param {string} file
 * @param {string} workspace
 * @returns {Scan}
 */
function scan(file, workspace) {
  const id = sessionIdOf(file);
  if (!SESSION.test(id)) throw new Error(`Unexpected chat session file name: ${path.basename(file)}`);
  const stat = fs.statSync(file);
  let s = scans.get(file);
  if (!s || stat.size < s.offset) {
    s = { offset: 0, size: -1, mtime: 0, lines: 0, id, model: null, title: null, started: '', lastAt: '', turnOpen: false, running: new Map(), requested: new Map(), contracts: [],
      opened: new Set(), edited: new Set() };
    scans.set(file, s);
  }
  if (s.size === stat.size && s.mtime === stat.mtimeMs) return s;
  const handle = fs.openSync(file, 'r');
  try {
    while (s.offset < stat.size) {
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, stat.size - s.offset));
      const read = fs.readSync(handle, buffer, 0, buffer.length, s.offset);
      const end = buffer.subarray(0, read).lastIndexOf(0x0a);
      if (end < 0) {
        if (read === CHUNK_BYTES) throw new Error(`Line ${s.lines + 1} of ${path.basename(file)} is longer than 4 MB.`);
        break;
      }
      for (const line of buffer.toString('utf8', 0, end).split('\n')) {
        s.lines += 1;
        if (!line.trim()) continue;
        try {
          apply(s, record(JSON.parse(line), `${path.basename(file)} line ${s.lines}`), workspace);
        } catch (error) {
          scans.delete(file);
          throw new Error(`Invalid chat event on line ${s.lines} of ${path.basename(file)}`, { cause: error });
        }
      }
      s.offset += end + 1;
    }
  } finally {
    fs.closeSync(handle);
  }
  s.size = stat.size;
  s.mtime = stat.mtimeMs;
  return s;
}

/** Return the asks a chat works on: the one it was opened for, then those it created, reopened or edited files in.
 * @param {Scan} s
 * @param {string[]} asks
 * @param {import('./types').Claim | null} claim
 * @returns {import('./types').ChatLink[]}
 */
function links(s, asks, claim) {
  /** @type {Map<string, import('./types').ChatLink['how']>} */
  const found = new Map();
  if (claim && asks.includes(claim.ask)) found.set(claim.ask, claim.how);
  for (const { slug, at } of s.contracts) {
    const minute = Math.floor(at / 60000) * 60000;
    const made = asks.filter(id => id.slice(14) === slug && askTime(id) >= minute - 60000 && askTime(id) <= at + CREATED_WITHIN_MS)
      .sort((a, b) => askTime(a) - askTime(b))[0];
    if (made && !found.has(made)) found.set(made, 'created');
  }
  for (const id of s.opened) if (asks.includes(id) && !found.has(id)) found.set(id, 'opened');
  for (const id of s.edited) if (asks.includes(id) && !found.has(id)) found.set(id, 'edited');
  return [...found].map(([ask, how]) => ({ ask, how }));
}

/** Return the recent chats of this window (Local transcripts and workspace Copilot sessions), newest first, with the asks each works on.
 * @param {string | null} transcripts
 * @param {string} workspace
 * @param {string[]} asks
 * @param {Record<string, import('./types').Claim>} claims
 * @param {import('./types').Pending | null} pending
 * @param {number} now
 * @param {string | null} [copilotRoot]
 * @returns {{chats: import('./types').Chat[], claimed: {chat: string, ask: string} | null}}
 */
function chatList(transcripts, workspace, asks, claims, pending, now, copilotRoot = null) {
  /** @type {Map<string, {file: string, mtime: number}>} */
  const candidates = new Map();
  if (transcripts && fs.existsSync(transcripts)) {
    for (const name of fs.readdirSync(transcripts).filter(entry => entry.endsWith('.jsonl'))) {
      const file = path.join(transcripts, name);
      candidates.set(path.basename(name, '.jsonl'), { file, mtime: fs.statSync(file).mtimeMs });
    }
  }
  for (const row of copilotFiles(workspace, copilotRoot)) {
    const existing = candidates.get(row.id);
    if (!existing || row.mtime >= existing.mtime) candidates.set(row.id, { file: row.file, mtime: row.mtime });
  }
  if (!candidates.size) return { chats: [], claimed: null };
  const scanned = [...candidates.values()].sort((a, b) => b.mtime - a.mtime).slice(0, CHAT_LIMIT)
    .map(({ file }) => scan(file, workspace)).filter(s => s.lastAt);
  const fresh = pending ? scanned.filter(s => !Object.hasOwn(claims, s.id) && Date.parse(s.started) >= Date.parse(pending.at) - 5000)
    .sort((a, b) => a.started.localeCompare(b.started))[0] : undefined;
  const claimed = pending && fresh ? { chat: fresh.id, ask: pending.ask } : null;
  const chats = scanned.map(s => ({ id: s.id, title: s.title, started: s.started, lastAt: s.lastAt,
    status: (() => {
      const last = [...s.running.values()].at(-1);
      const open = last && stillRunning(last.tool, last.at, now) ? last.tool : null;
      return status(open, s.turnOpen, s.lastAt, now, !open && !!awaiting(s.requested, now));
    })(),
    asks: links(s, asks, claimed?.chat === s.id ? { ask: claimed.ask, how: 'started' } : claims[s.id] || null) }));
  return { chats: chats.sort((a, b) => b.lastAt.localeCompare(a.lastAt)), claimed };
}

/** Return the chat to show: the ask's most recently active chat (with no ask, the latest chat). A chat the user picked shows until another
 * chat of the ask is active after the pick. With follow set and the ask's chat idle, a working chat no ask claims is shown instead, so a
 * chat that only reads and analyses is not hidden behind an idle one.
 * @param {import('./types').Chat[]} chats
 * @param {string | null} ask
 * @param {{id: string, at: string} | null} chosen
 * @param {boolean} follow
 * @returns {import('./types').Chat | null}
 */
function shownChat(chats, ask, chosen, follow) {
  const mine = ask === null ? chats : chats.filter(chat => chat.asks.some(link => link.ask === ask));
  const picked = chosen && chats.find(chat => chat.id === chosen.id);
  if (picked && !mine.some(chat => chat.id !== picked.id && chat.lastAt > chosen.at)) return picked;
  const loose = follow && (!mine[0] || mine[0].status === 'idle') ? chats.find(chat => !chat.asks.length && chat.status !== 'idle') : undefined;
  return loose || mine[0] || null;
}

/** Validate the saved chat-to-ask links.
 * @param {unknown} value
 * @returns {Record<string, import('./types').Claim>}
 */
function claimsFrom(value) {
  if (value === undefined) return {};
  return Object.fromEntries(Object.entries(record(value, 'Saved chat links')).map(([chat, row]) => {
    const claim = record(row, 'Saved chat link');
    const ask = text(claim.ask, 'Linked ask');
    const how = text(claim.how, 'Link kind');
    if (!SESSION.test(chat) || !ASK.test(ask) || !HOW.includes(how)) throw new Error(`Invalid saved chat link: ${chat}`);
    return [chat, { ask, how: /** @type {import('./types').Claim['how']} */ (how) }];
  }));
}

/** Validate the saved new-chat request; it lapses an hour after it was made.
 * @param {unknown} value
 * @param {number} now
 * @returns {import('./types').Pending | null}
 */
function pendingFrom(value, now) {
  if (value === undefined || value === null) return null;
  const row = record(value, 'Saved new chat');
  const ask = text(row.ask, 'New chat ask');
  const at = text(row.at, 'New chat time');
  if (!ASK.test(ask) || Number.isNaN(Date.parse(at))) throw new Error('Invalid saved new chat.');
  return now - Date.parse(at) < PENDING_MS ? { ask, at } : null;
}

/** @type {Map<string, {size: number, mtime: number, meta: import('./types').ChatMeta}>} */
const metas = new Map();

/** Resolve a chat session id to its Local transcript or Copilot session-state events.jsonl file.
 * @param {string | null} transcripts
 * @param {string | null} copilotRoot
 * @param {string} id
 * @returns {string | null}
 */
function transcriptPath(transcripts, copilotRoot, id) {
  if (!SESSION.test(id)) throw new Error(`Invalid chat session id: ${id}`);
  const local = transcripts ? path.join(transcripts, `${id}.jsonl`) : null;
  if (local && fs.existsSync(local)) return local;
  const copilot = copilotRoot ? path.join(copilotRoot, id, 'events.jsonl') : null;
  return copilot && fs.existsSync(copilot) ? copilot : local;
}

/** Return true when id belongs to this window's Local chat transcripts (openable via vscode-chat-session://local/).
 * @param {string | null} transcripts
 * @param {string} id
 * @returns {boolean}
 */
function isLocalChat(transcripts, id) {
  return Boolean(transcripts && SESSION.test(id) && fs.existsSync(path.join(transcripts, `${id}.jsonl`)));
}

/** Return the agent, execution mode and model of a chat from VS Code's own session record or Copilot session-state.
 * @param {string | null} transcripts
 * @param {string} id
 * @param {string | null} [copilotRoot]
 * @param {string | null} [askAgent]
 * @returns {import('./types').ChatMeta}
 */
function chatMeta(transcripts, id, copilotRoot = null, askAgent = null) {
  if (!SESSION.test(id)) throw new Error(`Invalid chat session id: ${id}`);
  const file = transcripts ? path.join(path.dirname(path.dirname(transcripts)), 'chatSessions', `${id}.jsonl`) : null;
  if (!file || !fs.existsSync(file)) {
    const events = copilotRoot ? path.join(copilotRoot, id, 'events.jsonl') : null;
    if (events && fs.existsSync(events)) {
      const yaml = path.join(copilotRoot || '', id, 'workspace.yaml');
      const client = fs.existsSync(yaml) ? readWorkspaceYaml(yaml).client : null;
      return { agent: askAgent, model: scans.get(events)?.model || null, mode: client === 'cli' ? 'Copilot CLI' : 'Copilot' };
    }
    return { agent: null, model: null, mode: null };
  }
  const stat = fs.statSync(file);
  const hit = metas.get(file);
  if (hit && hit.size === stat.size && hit.mtime === stat.mtimeMs) return hit.meta;
  /** @param {number} limit @returns {import('./types').ChatMeta} */
  const read = limit => {
    const start = Math.max(0, stat.size - limit);
    const handle = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(handle, buffer, 0, buffer.length, start);
      const content = buffer.toString('utf8');
      /** @param {RegExp} pattern @returns {string | null} */
      const last = pattern => [...content.matchAll(pattern)].at(-1)?.[1] || null;
      return { agent: last(/"telemetryModeName":"([^"]{1,80})"/g), model: last(/"modelId":"(?:copilot\/)?([^"]{1,80})"/g), mode: 'Local' };
    } finally {
      fs.closeSync(handle);
    }
  };
  const tail = read(CHUNK_BYTES);
  const meta = tail.agent && tail.model ? tail : read(stat.size);
  metas.set(file, { size: stat.size, mtime: stat.mtimeMs, meta });
  return meta;
}

/** Return VS Code's address of a local chat session, which `vscode.open` opens as a chat editor with its history.
 * @param {string} id The chat's session id, also its transcript's name.
 * @returns {string}
 */
function chatSessionUri(id) {
  if (!SESSION.test(id)) throw new Error(`Invalid chat session id: ${id}`);
  return `vscode-chat-session://local/${Buffer.from(id, 'utf8').toString('base64url')}`;
}

module.exports = { SESSION, chatList, shownChat, claimsFrom, pendingFrom, chatMeta, chatSessionUri, transcriptPath, isLocalChat, copilotDigest };
