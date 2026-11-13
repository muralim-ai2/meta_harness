'use strict';
/** Read one chat's live agent activity: its Copilot Chat transcript, its harness run files, and research telemetry. */
const fs = require('node:fs');
const path = require('node:path');
const { Reader } = require('./file-access');
const { record, text, list, flag, integer } = require('./validate');
const { otelUsage } = require('./insights');
const { BRAND } = require('../brand');
const STATE = BRAND.state_dir;
const TAIL_BYTES = 8 * 1024 * 1024;
const IDLE_AFTER_MS = 5 * 60 * 1000, QUICK_TOOL_MS = 60 * 1000, APPROVAL_MS = 3000, APPROVAL_LAPSE_MS = 60 * 60 * 1000, IMAGE_BYTES = 6000;
/** @type {Record<string, string>} */
const CONTEXT_GROUP = { read: 'reads', edit: 'edits', run: 'commands', search: 'searches', delegate: 'subagents', ask: 'questions', todo: 'other', tool: 'other' };
const LONG_TOOLS = new Set(['run_in_terminal', 'powershell', 'bash', 'shell', 'exec_command', 'get_terminal_output', 'read_powershell', 'read_bash',
  'runSubagent', 'task', 'execution_subagent', 'search_subagent', 'explore_subagent', 'run_playwright_code', 'vscode_askQuestions', 'ask_user']);
const SHELL_TOOLS = new Set(['run_in_terminal', 'powershell', 'bash', 'shell', 'exec_command']);
const READ_FILE_TOOLS = new Set(['read_file', 'view']);
const EVENT_LIMIT = 80, SESSION = /^[\w-]+$/, ASK_TOOLS = new Set(['vscode_askQuestions', 'ask_user']);
const TODO_STATES = ['not-started', 'in-progress', 'completed'];
const NAMED_FILES = [/\]\(([^)\s]+?)(?:#[^)\s]*)?\)/g, /`([^`\s]+\.[A-Za-z0-9]{1,8})`/g, /(?<![\w/\\.`(-])((?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]{1,8})\b/g];
/** @type {Map<string, {size: number, mtime: number, parsed: Parsed}>} */
const cache = new Map();

/** @typedef {import('./types').ActivityEvent} ActivityEvent */
/** @typedef {{id: string, title: string | null, model: string | null, started: string, lastAt: string, turnOpen: boolean, open: {event: ActivityEvent, tool: string} | null,
 *   requested: Map<string, ActivityEvent>, turns: number, tools: number, failures: number, commands: number, todos: import('./types').Todo[], events: ActivityEvent[],
 *   files: Map<string, {count: number, last: string}>, chars: {user: number, agent: number, args: number}, skills: Map<string, number>,
 *   calls: Map<string, {title: string, count: number}>, gap: {from: string, to: string} | null, context: Map<string, {count: number, bytes: number, items: string[]}>,
 *   main: {turns: number, tools: number, reads: number, skills: number}, subagents: import('./types').SubagentTrace[], tokens: import('./types').Activity['tokens']}} Parsed */

/** Return the end of a file, starting at a line boundary when it was cut. @param {string} file @param {number} limit @returns {string} */
function tail(file, limit) {
  const size = fs.statSync(file).size, start = Math.max(0, size - limit), handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(handle, buffer, 0, buffer.length, start);
    const content = buffer.toString('utf8');
    return start === 0 ? content : content.slice(content.indexOf('\n') + 1);
  } finally { fs.closeSync(handle); }
}

/** Parse newline-terminated JSON lines; an unterminated last line waits until complete. @param {string} content @param {string} source @returns {Record<string, unknown>[]} */
function jsonLines(content, source) {
  const lines = content.split('\n');
  lines.pop();
  return lines.map((line, index) => ({ line: line.trim(), index })).filter(row => row.line).map(({ line, index }) => {
    try { return record(JSON.parse(line), `${source} line ${index + 1}`); }
    catch (error) { throw new Error(`Invalid JSON on line ${index + 1} of ${source}`, { cause: error }); }
  });
}

/** Return text on one line, cut at a word boundary. @param {string} value @param {number} limit @returns {string} */
function clip(value, limit) {
  const line = value.replace(/\s+/g, ' ').trim();
  if (line.length <= limit) return line;
  const cut = line.slice(0, limit - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), limit * 0.6))}…`;
}

/** Return the first meaningful line of a message as a short headline. @param {string} value @returns {string} */
function headline(value) {
  const line = value.split(/\r?\n/).map(row => row.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim()).find(Boolean) || '';
  if (line.length <= 80) return line;
  const cut = /^(.{30,80}?)(?:\s\(|:\s|;\s|\s[-—–]\s|\.\s)/.exec(line);
  return cut ? cut[1] : clip(line, 80);
}

/** Return a path relative to the workspace with forward slashes, or null when outside. @param {string} file @param {string} workspace @returns {string | null} */
function inside(file, workspace) {
  const relative = path.relative(workspace, path.resolve(workspace, file));
  return !relative || relative.startsWith('..') || path.isAbsolute(relative) ? null : relative.split(path.sep).join('/');
}

/** Return the workspace files a question or guard alert names (markdown links, code spans and plain paths), relative with forward slashes.
 * @param {string} value
 * @param {string} workspace
 * @returns {string[]}
 */
function referenced(value, workspace) {
  const names = NAMED_FILES.flatMap(pattern => [...value.matchAll(pattern)].map(match => inside(match[1].replace(/%20/g, ' '), workspace)));
  return [...new Set(names.filter(/** @returns {name is string} */ name => name !== null && fs.existsSync(path.join(workspace, name))
    && fs.statSync(path.join(workspace, name)).isFile()))];
}

/** Return a short display name for a file: workspace-relative, or its folder and name.
 * @param {string} file
 * @param {string} workspace
 * @returns {string}
 */
function shown(file, workspace) {
  return inside(file, workspace) || path.join(path.basename(path.dirname(file)), path.basename(file)).split(path.sep).join('/');
}

/** Return a command on one line with harness script paths shortened to the script name.
 * @param {string} value
 * @returns {string}
 */
function shortCommand(value) {
  return value.replace(/(["']?)[^"'\s]*[\\/](?:runtime[\\/])?(?:tools|hooks)[\\/](?:[\w-]+[\\/])*([\w-]+\.py)\1/g, '$2').replace(/\s+/g, ' ').trim();
}

/** Return a string argument or null.
 * @param {Record<string, unknown>} args
 * @param {string} key
 * @returns {string | null}
 */
function arg(args, key) {
  return typeof args[key] === 'string' && args[key] ? /** @type {string} */ (args[key]) : null;
}

/** Return the files an editing tool call names.
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @returns {string[]}
 */
function editedFiles(tool, args) {
  if (tool === 'multi_replace_string_in_file') {
    return [...new Set(list(args.replacements, 'Replacements').map(row => text(record(row, 'Replacement').filePath, 'Replacement file')))];
  }
  if (tool === 'apply_patch') return [...text(args.input, 'Patch').matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map(match => match[1].trim());
  const file = arg(args, 'filePath') || arg(args, 'path');
  return file ? [file] : [];
}

/** Describe one tool call in plain words.
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @param {string} workspace
 * @param {string} at
 * @returns {ActivityEvent}
 */
function describe(tool, args, workspace, at) {
  /** @type {(kind: ActivityEvent['kind'], title: string, detail?: string, files?: string[]) => ActivityEvent} */
  const event = (kind, title, detail = '', files = []) => ({ at, kind, title, detail, files, state: 'running' });
  const file = arg(args, 'filePath') || arg(args, 'path');
  switch (tool) {
    case 'read_file': case 'view_image': case 'view': return event('read', file ? `Read ${shown(file, workspace)}` : 'Read a file');
    case 'skill': { const sk = arg(args, 'skill'); return event('read', sk ? `Loaded skill ${sk}` : 'Loaded a skill'); }
    case 'create_file': case 'create': return event('edit', file ? `Created ${shown(file, workspace)}` : 'Created a file', '', file ? [file] : []);
    case 'replace_string_in_file': case 'insert_edit_into_file': case 'edit_notebook_file': case 'multi_replace_string_in_file': case 'apply_patch': case 'edit': {
      const files = editedFiles(tool, args);
      return event('edit', files.length === 1 ? `Edited ${shown(files[0], workspace)}` : `Edited ${files.length} files`,
        files.length > 1 ? files.map(name => shown(name, workspace)).join(', ') : arg(args, 'explanation') || '', files);
    }
    case 'create_directory': return event('edit', `Created folder ${shown(arg(args, 'dirPath') || '.', workspace)}`);
    case 'run_in_terminal': case 'powershell': case 'bash': case 'shell': case 'exec_command': {
      const command = shortCommand(arg(args, 'command') || '');
      const explanation = arg(args, 'explanation') || arg(args, 'description');
      return event('run', explanation ? clip(explanation.replace(/\.$/, ''), 90) : command ? `Ran ${clip(command, 90)}` : 'Ran a command', clip(command, 200));
    }
    case 'get_terminal_output': case 'read_powershell': case 'read_bash': return event('run', 'Checked terminal output');
    case 'list_dir': return event('read', `Listed ${shown(arg(args, 'path') || '.', workspace)}`);
    case 'grep_search': case 'file_search': case 'semantic_search': case 'grep': case 'glob':
      return event('search', `Searched for “${clip(arg(args, 'query') || arg(args, 'pattern') || '', 60)}”`);
    case 'manage_todo_list': return event('todo', 'Updated its to-do list');
    case 'vscode_askQuestions': case 'ask_user': {
      if (!Array.isArray(args.questions) && typeof args.message === 'string') {
        return event('ask', 'Asked you a question', clip(args.message, 120), referenced(args.message, workspace));
      }
      const questions = Array.isArray(args.questions) ? args.questions.map(row => record(row, 'Question')) : [];
      return event('ask', `Asked you ${questions.length || 'a'} question${questions.length === 1 ? '' : 's'}`,
        questions.map(row => arg(row, 'header') || arg(row, 'question') || '').filter(Boolean).join(' · '),
        referenced(questions.flatMap(row => ['question', 'message'].map(key => arg(row, key) || '')).join('\n'), workspace));
    }
    case 'runSubagent': case 'task':
      return event('delegate', `Handed off to ${arg(args, 'agentName') || arg(args, 'name') || arg(args, 'agent_type') || 'a sub-agent'}`, arg(args, 'description') || '');
    case 'execution_subagent': case 'search_subagent': case 'explore_subagent': return event('delegate', 'Started a helper agent', arg(args, 'description') || '');
    case 'fetch_webpage': return event('search', 'Fetched a web page', Array.isArray(args.urls) ? args.urls.join(', ') : '');
    case 'get_errors': return event('read', 'Checked problems');
    case 'task_complete': return event('message', 'Marked the task complete');
    default: return event('tool', `Used ${tool.replace(/^mcp_/, '').replace(/[_-]+/g, ' ')}`);
  }
}

/** Return the agent's to-do list from a manage_todo_list call.
 * @param {Record<string, unknown>} args
 * @returns {import('./types').Todo[]}
 */
function todoList(args) {
  return list(args.todoList, 'To-do list').map(value => {
    const row = record(value, 'To-do item');
    const status = text(row.status, 'To-do status');
    if (!TODO_STATES.includes(status)) throw new Error(`Unknown to-do status: ${status}`);
    return { title: text(row.title, 'To-do title'), status: /** @type {import('./types').Todo['status']} */ (status) };
  });
}

/** Mark tool calls that never reported a result as stopped once the conversation moved on: the agent answered or you wrote again.
 * @param {Map<string, {event: ActivityEvent, tool: string}>} running
 * @returns {void}
 */
function settle(running) {
  for (const call of running.values()) call.event.state = 'stopped';
  running.clear();
}

/** Return the tool calls an agent message asks for, by call id. Copilot records a call's start only once it runs, so a command waiting for
 * your Allow shows only here.
 * @param {Record<string, unknown>} data
 * @param {string} workspace
 * @param {string} at
 * @returns {Map<string, ActivityEvent>}
 */
function requested(data, workspace, at) {
  const rows = data.toolRequests === undefined ? [] : list(data.toolRequests, 'Tool requests').map(value => record(value, 'Tool request'));
  return new Map(rows.map(row => {
    const tool = text(row.name, 'Requested tool');
    const args = row.arguments === undefined ? {} : record(typeof row.arguments === 'string' ? JSON.parse(row.arguments) : row.arguments, `${tool} request arguments`);
    return [text(row.toolCallId, 'Requested tool call id'), { ...describe(tool, args, workspace, at), state: /** @type {const} */ ('pending') }];
  }));
}

/** Return the newest requested call that has not started for a few seconds: it waits for your approval in Chat. After an hour it is no longer
 * a wait: the chat was left or the step was skipped.
 * @param {Map<string, ActivityEvent>} calls
 * @param {number} now
 * @returns {ActivityEvent | null}
 */
function awaiting(calls, now) {
  return [...calls.values()].filter(event => now - Date.parse(event.at) >= APPROVAL_MS && now - Date.parse(event.at) < APPROVAL_LAPSE_MS).at(-1) || null;
}

/** Estimate bytes read by a file read call, scaling line-bounded slices instead of counting the full file size.
 * @param {string | null} file
 * @param {Record<string, unknown>} args
 * @param {number} fallback
 * @returns {number}
 */
function readBytes(file, args, fallback) {
  if (!file || !path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return fallback;
  const full = fs.statSync(file).size;
  if (typeof args.startLine === 'number' && typeof args.endLine === 'number' && args.endLine >= args.startLine) {
    return Math.min(full, Math.max(1, args.endLine - args.startLine + 1) * 45);
  }
  const vr = Array.isArray(args.view_range) ? args.view_range : null;
  if (vr && typeof vr[0] === 'number' && typeof vr[1] === 'number' && vr[1] >= vr[0]) return Math.min(full, Math.max(1, vr[1] - vr[0] + 1) * 45);
  return full;
}

/** Return a clean model name without provider suffixes such as "(copilot)".
 * @param {string | null} value
 * @returns {string | null}
 */
function cleanModel(value) {
  return value ? value.replace(/\s+\(copilot\)$/i, '').trim() || null : null;
}

/** Resolve the agent or persona a sub-agent tool call invokes from its arguments, delegation brief or ask contract.
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @param {string} workspace
 * @returns {string}
 */
function subagentRole(tool, args, workspace) {
  const explicit = arg(args, 'agentName') || arg(args, 'name') || arg(args, 'agent_type') || arg(args, 'subagent_type');
  if (explicit) return explicit;
  if (tool === 'explore_subagent') return 'explore';
  if (tool === 'search_subagent') return 'search';
  if (tool === 'execution_subagent') return 'execution';
  const prompt = arg(args, 'prompt') || '';
  const packAgent = /^- Pack agent for this stage:\s*([^\s(]+)/m.exec(prompt);
  if (packAgent) return packAgent[1];
  const brief = /(?:Frontier HVE|[\w][\w .-]*) brief:\s*ask\s+([\w-]+),\s*stage\s+([\w.-]+)(?:,\s*task\s+([\w.-]+))?/.exec(prompt);
  if (brief) {
    const contractFile = path.join(workspace, STATE, 'asks', brief[1], 'contract.json');
    if (fs.existsSync(contractFile)) {
      const contract = record(JSON.parse(fs.readFileSync(contractFile, 'utf8')), 'Ask contract');
      const delegations = Array.isArray(contract.delegations) ? contract.delegations.map(row => record(row, 'Delegation')) : [];
      const hit = delegations.find(row => (brief[3] ? row.task === brief[3] : row.stage === brief[2]) && typeof row.persona === 'string' && row.persona);
      if (hit) return /** @type {string} */ (hit.persona);
      const stages = Array.isArray(contract.stages) ? contract.stages.map(row => record(row, 'Stage')) : [];
      const stage = stages.find(row => row.name === brief[2] && typeof row.agent === 'string' && row.agent);
      if (stage) return stage.agent === 'self' && typeof contract.agent === 'string' ? contract.agent : /** @type {string} */ (stage.agent);
    }
  }
  if (/output-evaluation reviewer/i.test(prompt)) return 'evaluation-reviewer';
  if (/read-only evaluator/i.test(prompt)) return 'rubric-evaluator';
  if (/product council/i.test(prompt)) return 'council';
  if (/wow-uplift|uplift[- ]judge/i.test(prompt)) return 'uplift-judge';
  return 'sub-agent';
}

/** Parse one transcript into its session facts, separating main-agent activity from sub-agent brackets.
 * @param {string} file
 * @param {string} workspace
 * @returns {Parsed}
 */
function parse(file, workspace) {
  const base = path.basename(file, '.jsonl');
  const id = base === 'events' ? path.basename(path.dirname(file)) : base;
  if (!SESSION.test(id)) throw new Error(`Unexpected chat session file name: ${path.basename(file)}`);
  /** @type {Parsed} */
  const s = { id, title: null, model: null, started: '', lastAt: '', turnOpen: false, open: null, requested: new Map(), turns: 0, tools: 0, failures: 0, commands: 0, todos: [],
    events: [], files: new Map(), chars: { user: 0, agent: 0, args: 0 }, skills: new Map(), calls: new Map(), gap: null, context: new Map(),
    main: { turns: 0, tools: 0, reads: 0, skills: 0 }, subagents: [], tokens: null };
  /** @type {Map<string, import('./types').TokenUse>} */
  const models = new Map();
  const mainUsage = { calls: 0, input: 0, output: 0, cached: 0, reasoning: 0, peakInput: 0, aiu: 0 };
  let nano = 0;
  /** @type {(import('./types').SubagentTrace & {promptSeen?: boolean})[]} */
  const subStack = [];
  /** @type {Map<string, {event: ActivityEvent, tool: string}>} */
  const running = new Map();
  for (const row of jsonLines(tail(file, TAIL_BYTES), path.basename(file))) {
    const type = text(row.type, 'Transcript event type');
    const at = text(row.timestamp, `${type} timestamp`);
    const data = record(row.data, `${type} data`);
    const activeSub = subStack.at(-1) || null;
    if (s.lastAt && (!s.gap || Date.parse(at) - Date.parse(s.lastAt) > Date.parse(s.gap.to) - Date.parse(s.gap.from))) s.gap = { from: s.lastAt, to: at };
    s.started ||= at;
    s.lastAt = at;
    if (type === 'session.start') {
      s.started = text(data.startTime, 'Session start time');
      if (typeof data.selectedModel === 'string' && data.selectedModel) s.model = cleanModel(data.selectedModel);
    }
    else if (type === 'user.message') {
      const unprompted = subStack.find(sub => !sub.promptSeen && sub.turns === 0);
      if (unprompted) { unprompted.promptSeen = true; continue; }
      for (const sub of subStack) { sub.state = 'stopped'; sub.endAt = at; }
      subStack.length = 0;
      settle(running);
      s.requested.clear();
      const content = text(data.content, 'Your message', true);
      s.chars.user += content.length;
      if (content.trim()) {
        s.title ||= headline(content);
        s.events.push({ at, kind: 'prompt', title: headline(content), detail: '', files: [], state: 'ok' });
      }
    } else if (type === 'assistant.turn_start') {
      s.turnOpen = true; s.turns += 1;
      if (activeSub) activeSub.turns += 1; else s.main.turns += 1;
    } else if (type === 'assistant.turn_end') s.turnOpen = false;
    else if (type === 'abort') {
      for (const sub of subStack) { sub.state = 'stopped'; sub.endAt = at; }
      subStack.length = 0;
      s.turnOpen = false; settle(running); s.requested.clear();
    } else if (type === 'skill.invoked' && typeof data.name === 'string') {
      const skPath = typeof data.path === 'string' && fs.existsSync(data.path) ? fs.statSync(data.path).size : 0;
      if (!s.skills.has(data.name)) s.skills.set(data.name, skPath);
    } else if (type === 'session.usage_record' && data.usage && typeof data.usage === 'object') {
      const u = record(data.usage, 'Session usage');
      const m = text(u.responseModel ?? u.modelDisplayName ?? u.model, 'Usage model');
      s.model ||= cleanModel(m);
      const inp = u.inputTokens === undefined ? 0 : integer(u.inputTokens, 'Input tokens');
      const out = u.outputTokens === undefined ? 0 : integer(u.outputTokens, 'Output tokens');
      const cac = u.cacheReadTokens === undefined ? 0 : integer(u.cacheReadTokens, 'Cached tokens');
      const rea = u.reasoningTokens === undefined ? 0 : integer(u.reasoningTokens, 'Thinking tokens');
      const cu = u.copilotUsage && typeof u.copilotUsage === 'object' ? /** @type {Record<string, unknown>} */ (u.copilotUsage) : null;
      const callNano = cu && cu.totalNanoAiu !== undefined ? integer(cu.totalNanoAiu, 'AI units') : 0;
      const use = models.get(m) || { model: m, calls: 0, failed: 0, input: 0, output: 0, cached: 0, reasoning: 0 };
      use.calls += 1; use.input += inp; use.output += out; use.cached += cac; use.reasoning += rea;
      models.set(m, use);
      nano += callNano;
      mainUsage.calls += 1; mainUsage.input += inp; mainUsage.output += out; mainUsage.cached += cac; mainUsage.reasoning += rea;
      mainUsage.peakInput = Math.max(mainUsage.peakInput, inp); mainUsage.aiu += callNano / 1e9;
    } else if (type === 'assistant.message') {
      const msgModel = typeof data.model === 'string' && data.model ? cleanModel(data.model) : null;
      if (activeSub) {
        if (!activeSub.model && msgModel) activeSub.model = msgModel;
      } else {
        settle(running);
        s.requested = requested(data, workspace, at);
        if (msgModel) s.model = msgModel;
      }
      const content = text(data.content, 'Agent message', true);
      if (!activeSub) s.chars.agent += content.length;
      if (content.trim()) s.events.push({ at, kind: 'message', title: clip(content, 160), detail: '', files: [], state: 'ok' });
    } else if (type === 'tool.execution_start') {
      const tool = text(data.toolName, 'Tool name');
      const callId = text(data.toolCallId, 'Tool call id');
      s.requested.delete(callId);
      const rawArgs = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments;
      const args = rawArgs === undefined ? {} : record(rawArgs, `${tool} arguments`);
      const event = describe(tool, args, workspace, at);
      const key = `${tool} ${JSON.stringify(args)}`;
      s.calls.set(key, { title: event.title, count: (s.calls.get(key)?.count || 0) + 1 });
      const readTarget = READ_FILE_TOOLS.has(tool) ? (arg(args, 'filePath') || arg(args, 'path')) : null;
      const skill = readTarget && /[\\/]([^\\/]+)[\\/]SKILL\.md$/i.exec(readTarget);
      if (skill && !s.skills.has(skill[1])) s.skills.set(skill[1], fs.existsSync(readTarget) ? fs.statSync(readTarget).size : 0);
      const isSkill = Boolean(skill || tool === 'skill');
      if (activeSub) {
        activeSub.tools += 1;
        if (event.kind === 'read') activeSub.reads += 1;
        if (isSkill) activeSub.skills += 1;
        if (!activeSub.model && typeof data.model === 'string') activeSub.model = data.model;
      } else {
        s.chars.args += key.length;
        s.main.tools += 1;
        if (event.kind === 'read') s.main.reads += 1;
        if (isSkill) s.main.skills += 1;
        const group = isSkill ? 'skills' : tool === 'view_image' ? 'images' : tool === 'fetch_webpage' ? 'web' : CONTEXT_GROUP[event.kind] || 'other';
        const bytes = tool === 'view_image' ? IMAGE_BYTES : readBytes(readTarget, args, key.length);
        const row = s.context.get(group) || { count: 0, bytes: 0, items: [] };
        row.count += 1; row.bytes += bytes;
        if (row.items.length < 4 && !row.items.includes(event.title)) row.items.push(event.title);
        s.context.set(group, row);
      }
      if (tool === 'runSubagent' || tool === 'task' || tool === 'explore_subagent' || tool === 'search_subagent' || tool === 'execution_subagent') {
        const sub = { id: callId, name: subagentRole(tool, args, workspace),
          task: arg(args, 'description') || '', startAt: at, endAt: null, state: /** @type {const} */ ('running'), turns: 0, tools: 0, reads: 0, skills: 0,
          model: cleanModel(arg(args, 'model') || (typeof data.model === 'string' ? data.model : null)) };
        s.subagents.push(sub);
        subStack.push(sub);
      }
      s.tools += 1;
      if (SHELL_TOOLS.has(tool)) s.commands += 1;
      if (tool === 'manage_todo_list') s.todos = todoList(args);
      for (const name of event.kind === 'edit' ? event.files : []) {
        const relative = inside(name, workspace);
        if (relative) s.files.set(relative, { count: (s.files.get(relative)?.count || 0) + 1, last: at });
      }
      s.events.push(event);
      running.set(callId, { event, tool });
    } else if (type === 'tool.execution_complete') {
      const callId = text(data.toolCallId, 'Tool call id');
      const call = running.get(callId);
      if (call) {
        running.delete(callId);
        call.event.state = data.success === false ? 'failed' : 'ok';
        if (call.event.state === 'failed') s.failures += 1;
      }
      const subIdx = subStack.findIndex(sub => sub.id === callId);
      if (subIdx >= 0) {
        const [doneSub] = subStack.splice(subIdx, 1);
        doneSub.endAt = at;
        doneSub.state = data.success === false ? 'failed' : 'ok';
      }
    }
  }
  s.open = [...running.values()].at(-1) || null;
  s.tokens = models.size ? { models: [...models.values()].sort((a, b) => b.input - a.input), aiu: nano / 1e9, main: mainUsage, subSpans: [] } : null;
  return s;
}

/** Return a transcript's parsed facts, reparsing only when the file changed.
 * @param {string} file
 * @param {string} workspace
 * @returns {Parsed}
 */
function parsed(file, workspace) {
  const stat = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.size === stat.size && hit.mtime === stat.mtimeMs) return hit.parsed;
  const result = parse(file, workspace);
  cache.set(file, { size: stat.size, mtime: stat.mtimeMs, parsed: result });
  return result;
}

/** Return whether a tool call without a result may still be running: commands, sub-agents and questions can take long; a read, edit or search
 * that has reported nothing for a minute has stopped (Copilot sometimes never records its result).
 * @param {string} tool
 * @param {string} at When the call started.
 * @param {number} now
 * @returns {boolean}
 */
function stillRunning(tool, at, now) {
  return LONG_TOOLS.has(tool) || now - Date.parse(at) <= QUICK_TOOL_MS;
}

/** Return a chat's state: waiting for your answer or approval, working, or idle after five quiet minutes.
 * @param {string | null} openTool The tool still running, if any.
 * @param {boolean} turnOpen
 * @param {string} lastAt
 * @param {number} now
 * @param {boolean} approval A requested call waits for your Allow.
 * @returns {import('./types').Session['status']}
 */
function status(openTool, turnOpen, lastAt, now, approval) {
  const quiet = now - Date.parse(lastAt) > IDLE_AFTER_MS;
  return approval || (openTool && ASK_TOOLS.has(openTool)) ? 'waiting' : !quiet && (openTool || turnOpen) ? 'working' : 'idle';
}

/** Return the session as shown: working, waiting for you, or idle after five quiet minutes; a stale quick call shows as stopped.
 * @param {Parsed} s
 * @param {number} now
 * @returns {import('./types').Session}
 */
function session(s, now) {
  const open = s.open && stillRunning(s.open.tool, s.open.event.at, now) ? s.open : null;
  const asked = open ? null : awaiting(s.requested, now);
  const state = status(open?.tool || null, s.turnOpen, s.lastAt, now, !!asked);
  const events = s.events.slice(-EVENT_LIMIT).reverse()
    .map(event => ({ ...event, state: event.state === 'running' && (state === 'idle' || event !== open?.event) ? 'stopped' : event.state }));
  const current = state === 'idle' ? null : asked ? { ...asked, kind: /** @type {const} */ ('ask'), title: 'Waiting for you to allow a step in Chat',
    detail: [asked.title, asked.detail].filter(Boolean).join(' — '), files: [] } : open?.event || null;
  return { id: s.id, title: s.title, started: s.started, lastAt: s.lastAt, status: state, current,
    last: events.find(event => event.kind !== 'prompt') || null,
    turns: s.turns, tools: s.tools, failures: s.failures, commands: s.commands, todos: s.todos, events,
    stats: { chars: { ...s.chars }, skills: [...s.skills].map(([name, bytes]) => ({ name, bytes })), gap: s.gap,
      repeats: [...s.calls.values()].filter(call => call.count >= 3).sort((a, b) => b.count - a.count).slice(0, 5),
      context: [...s.context].map(([group, row]) => ({ group, ...row, items: [...row.items] })).sort((a, b) => b.bytes - a.bytes),
      main: { ...s.main },
      model: s.model,
      subagents: s.subagents.map(sub => ({ ...sub, state: sub.state === 'running' && state === 'idle' ? 'stopped' : sub.state })) },
    files: [...s.files].map(([file, row]) => ({ path: file, ...row })).sort((a, b) => b.last.localeCompare(a.last)) };
}

/** Read the session's harness run files: the error guard, the skill load and guard alerts.
 * @param {string} workspace
 * @param {string} id
 * @returns {Pick<import('./types').Activity, 'errors' | 'loadout'> & {guards: ActivityEvent[]}}
 */
function runFiles(workspace, id) {
  const reader = new Reader(workspace);
  const runs = path.join(STATE, 'runs');
  const errorsValue = reader.json(path.join(runs, `${id}.errors.json`), true);
  const errors = errorsValue === undefined ? null : (() => {
    const value = record(errorsValue, 'Error guard state');
    return { paused: flag(value.paused, 'Error guard paused'), failures: list(value.failures, 'Error guard failures').map(row => {
      const failure = record(row, 'Failed command');
      return { command: shortCommand(text(failure.command, 'Failed command')), output: text(failure.output, 'Failed command output', true) };
    }) };
  })();
  const loadValue = reader.json(path.join(runs, `${id}.skills.json`), true);
  const loadout = loadValue === undefined ? null : (() => {
    const value = record(loadValue, 'Skill load');
    const budget = record(value.budget, 'Skill budget');
    return { skills: list(value.skills, 'Loaded skills').length, tokens: integer(value.tokens, 'Skill tokens'), overBudget: flag(value.over_budget, 'Over budget'),
      maxSkills: integer(budget.max_skills, 'Skill limit'), maxTokens: integer(budget.max_tokens, 'Token guideline') };
  })();
  const alerts = reader.text(path.join(runs, `${id}.interventions.jsonl`), true);
  const guards = alerts === undefined ? [] : jsonLines(alerts, `${id}.interventions.jsonl`).map(row => /** @type {ActivityEvent} */ ({
    at: new Date(/** @type {number} */ (row.ts_ms)).toISOString(), kind: 'guard', title: `Guard: ${text(row.hook, 'Guard hook').replace(/\.py$/, '').replace(/_/g, ' ')} ${text(row.kind, 'Guard action')}`,
    detail: clip(text(row.detail, 'Guard detail', true), 240), files: referenced(text(row.detail, 'Guard detail', true), workspace), state: 'ok' }));
  return { errors, loadout, guards };
}

/** Return the live activity of one chat session, or nothing when no chat is shown.
 * @param {string} workspace
 * @param {string | null} file The chat's transcript, or null when no chat is shown.
 * @param {string | null} telemetryFile The research telemetry export, or null when it was never configured.
 * @param {number} now
 * @returns {Omit<import('./types').Activity, 'chats' | 'meta'>}
 */
function activity(workspace, file, telemetryFile, now) {
  if (!file) return { session: null, errors: null, loadout: null, tokens: null };
  const raw = parsed(file, workspace);
  const current = session(raw, now);
  const run = runFiles(workspace, current.id);
  current.events = [...current.events, ...run.guards].sort((a, b) => b.at.localeCompare(a.at)).slice(0, EVENT_LIMIT);
  const otel = telemetryFile ? otelUsage(workspace, telemetryFile, current.id, { tail, jsonLines, inside }) : null;
  return { session: current, errors: run.errors, loadout: run.loadout, tokens: otel || raw.tokens };
}

module.exports = { activity, describe, status, stillRunning, requested, awaiting, headline, clip, jsonLines };
