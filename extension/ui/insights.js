'use strict';
/** Telemetry for one chat: main-agent vs sub-agent token/activity split, OTel span aggregation, warning signals, and the digest an analysis model reads. */
const fs = require('node:fs');
const path = require('node:path');
const { containedPath } = require('./file-access');
const { record, text, integer } = require('./validate');
const BASE_CONTEXT_TOKENS = 12000;
const AIU_PER_1K_INPUT = 0.125;
const CHARS_PER_TOKEN = 4;
const DIGEST_STEPS = 150;
const TELEMETRY_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_BYTES = 256 * 1024 * 1024;

/** Convert an OTel [seconds, nanoseconds] hrtime pair to epoch milliseconds, or 0 when absent. @param {unknown} value @returns {number} */
function hrMs(value) {
  return Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number' ? value[0] * 1000 + value[1] / 1e6 : 0;
}

/** Return parsed OTel JSON records from file belonging to session id, scanning past large non-chat spans in 4 MB chunks.
 * @param {string} file
 * @param {string} id
 * @param {{tail: (f: string, limit: number) => string, jsonLines: (c: string, s: string) => Record<string, unknown>[]}} io
 * @returns {Record<string, unknown>[]}
 */
function sessionRecords(file, id, io) {
  const size = fs.statSync(file).size;
  if (!size) return [];
  if (size <= TELEMETRY_TAIL_BYTES) return io.jsonLines(io.tail(file, TELEMETRY_TAIL_BYTES), path.basename(file));
  const handle = fs.openSync(file, 'r');
  /** @type {string[]} */
  const matched = [];
  let carry = '';
  let offset = Math.max(0, size - MAX_SCAN_BYTES);
  let skipFirst = offset > 0;
  try {
    while (offset < size) {
      const len = Math.min(TELEMETRY_TAIL_BYTES, size - offset);
      const buf = Buffer.alloc(len);
      const read = fs.readSync(handle, buf, 0, len, offset);
      if (read <= 0) break;
      offset += read;
      const chunk = carry + buf.toString('utf8', 0, read);
      const lines = chunk.split('\n');
      carry = lines.pop() ?? '';
      const startIdx = skipFirst ? 1 : 0;
      skipFirst = false;
      for (let i = startIdx; i < lines.length; i += 1) {
        if (lines[i].includes(id) && lines[i].includes('"chat ')) matched.push(lines[i]);
      }
    }
  } finally {
    fs.closeSync(handle);
  }
  return matched.length ? io.jsonLines(`${matched.join('\n')}\n`, path.basename(file)) : [];
}

/** Sum research telemetry model calls of one chat session from a workspace-contained export, separating main-agent from sub-agents.
 * @param {string} workspace
 * @param {string} file
 * @param {string} id
 * @param {{tail: (f: string, limit: number) => string, jsonLines: (c: string, s: string) => Record<string, unknown>[], inside: (f: string, w: string) => string | null}} io
 * @returns {import('./types').Activity['tokens']}
 */
function otelUsage(workspace, file, id, io) {
  const relative = io.inside(file, workspace);
  if (!relative) return null;
  const candidate = containedPath(workspace, relative);
  if (!candidate.endsWith('.jsonl') || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  /** @type {Map<string, import('./types').TokenUse>} */
  const models = new Map();
  const main = { calls: 0, input: 0, output: 0, cached: 0, reasoning: 0, peakInput: 0, aiu: 0 };
  /** @type {import('./types').SubagentSpan[]} */
  const subSpans = [];
  let nano = 0;
  for (const row of sessionRecords(candidate, id, io)) {
    if (typeof row.name !== 'string' || !row.name.startsWith('chat ')) continue;
    const attrs = record(row.attributes, 'Telemetry span attributes');
    const owners = [attrs['gen_ai.conversation.id'], attrs['copilot_chat.session_id'], attrs['copilot_chat.chat_session_id'], attrs['copilot_chat.parent_chat_session_id']];
    if (!owners.includes(id)) continue;
    const model = text(attrs['gen_ai.response.model'] ?? attrs['gen_ai.request.model'], 'Telemetry model');
    const use = models.get(model) || { model, calls: 0, failed: 0, input: 0, output: 0, cached: 0, reasoning: 0 };
    use.calls += 1;
    models.set(model, use);
    if (attrs['gen_ai.usage.input_tokens'] === undefined && record(row.status, 'Telemetry span status').code === 2) {
      use.failed += 1;
      continue;
    }
    const inp = integer(attrs['gen_ai.usage.input_tokens'], 'Input tokens');
    const out = integer(attrs['gen_ai.usage.output_tokens'], 'Output tokens');
    const cac = attrs['gen_ai.usage.cache_read.input_tokens'] === undefined ? 0 : integer(attrs['gen_ai.usage.cache_read.input_tokens'], 'Cached tokens');
    const rawR = attrs['gen_ai.usage.reasoning_tokens'] ?? attrs['gen_ai.usage.reasoning.output_tokens'];
    const rea = rawR === undefined ? 0 : integer(rawR, 'Thinking tokens');
    const spanNano = attrs['copilot_chat.copilot_usage_nano_aiu'] === undefined ? 0 : integer(attrs['copilot_chat.copilot_usage_nano_aiu'], 'AI units');
    use.input += inp; use.output += out; use.cached += cac; use.reasoning += rea;
    nano += spanNano;
    const agentAttr = typeof attrs['gen_ai.agent.name'] === 'string' ? attrs['gen_ai.agent.name'] : null;
    const subAgent = agentAttr && agentAttr.startsWith('tool/runSubagent-') ? agentAttr.slice('tool/runSubagent-'.length)
      : (typeof attrs['copilot_chat.mode_name'] === 'string' ? attrs['copilot_chat.mode_name'] : null);
    const isSub = (attrs['copilot_chat.parent_chat_session_id'] === id && attrs['copilot_chat.chat_session_id'] !== id)
      || Boolean(agentAttr && agentAttr.startsWith('tool/runSubagent'));
    if (isSub) {
      subSpans.push({ subId: String(attrs['copilot_chat.chat_session_id'] || 'sub'), agent: subAgent, startMs: hrMs(row.startTime), endMs: hrMs(row.endTime),
        model, input: inp, output: out, cached: cac, reasoning: rea, aiu: spanNano / 1e9 });
    } else {
      main.calls += 1; main.input += inp; main.output += out; main.cached += cac; main.reasoning += rea;
      main.peakInput = Math.max(main.peakInput, inp); main.aiu += spanNano / 1e9;
    }
  }
  return models.size ? { models: [...models.values()].sort((a, b) => b.input - a.input), aiu: nano / 1e9, main, subSpans } : null;
}

/** Return a character count as tokens.
 * @param {number} chars
 * @returns {number}
 */
function tokens(chars) { return Math.round(chars / CHARS_PER_TOKEN); }

/** Return a time of day in this machine's time zone.
 * @param {string | undefined} iso
 * @returns {string}
 */
function clock(iso) { return new Date(String(iso)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }

/** Join transcript sub-agent runs with any measured OTel sub-agent spans by tool call id or time window, resolving inherited agent and model.
 * @param {import('./types').SubagentTrace[]} traces
 * @param {import('./types').SubagentSpan[]} spans
 * @param {string | null} fallbackAgent
 * @param {string | null} fallbackModel
 * @returns {import('./types').SubagentInsight[]}
 */
function buildSubagents(traces, spans, fallbackAgent, fallbackModel) {
  const claimed = new Set();
  /** @type {import('./types').SubagentInsight[]} */
  const rows = traces.map(sub => {
    const byId = spans.filter((sp, idx) => !claimed.has(idx) && Boolean(sub.id && sp.subId === sub.id) && claimed.add(idx));
    const startMs = Date.parse(sub.startAt) - 2000;
    const endMs = (sub.endAt ? Date.parse(sub.endAt) : Number.POSITIVE_INFINITY) + 2000;
    const matched = byId.length ? byId : spans.filter((sp, idx) => !claimed.has(idx) && sp.startMs >= startMs && sp.startMs <= endMs && claimed.add(idx));
    const name = sub.name && sub.name !== 'sub-agent' ? sub.name
      : (matched.find(sp => sp.agent)?.agent || (fallbackAgent ? `${fallbackAgent} (sub-agent)` : 'sub-agent'));
    const resolvedModel = matched[0]?.model || sub.model || (sub.turns > 0 ? fallbackModel : null);
    if (!matched.length) {
      return { name, task: sub.task, model: resolvedModel, state: sub.state, turns: sub.turns, tools: sub.tools, reads: sub.reads,
        skills: sub.skills, measured: false, input: null, cached: null, nonCached: null, output: null, total: null, aiu: null };
    }
    const input = matched.reduce((sum, sp) => sum + sp.input, 0);
    const cached = matched.reduce((sum, sp) => sum + sp.cached, 0);
    const output = matched.reduce((sum, sp) => sum + sp.output, 0);
    const aiu = matched.reduce((sum, sp) => sum + sp.aiu, 0);
    return { name, task: sub.task, model: resolvedModel, state: sub.state, turns: sub.turns || matched.length,
      tools: sub.tools, reads: sub.reads, skills: sub.skills, measured: true, input, cached, nonCached: Math.max(0, input - cached),
      output, total: input + output, aiu };
  });
  /** @type {Map<string, import('./types').SubagentSpan[]>} */
  const extra = new Map();
  spans.forEach((sp, idx) => {
    if (!claimed.has(idx)) extra.set(sp.subId, [...(extra.get(sp.subId) || []), sp]);
  });
  for (const [subId, list] of extra) {
    const input = list.reduce((sum, sp) => sum + sp.input, 0);
    const cached = list.reduce((sum, sp) => sum + sp.cached, 0);
    const output = list.reduce((sum, sp) => sum + sp.output, 0);
    const aiu = list.reduce((sum, sp) => sum + sp.aiu, 0);
    rows.push({ name: list.find(sp => sp.agent)?.agent || `sub-agent (${subId.slice(0, 8)})`, task: '', model: list[0].model, state: 'ok', turns: list.length,
      tools: 0, reads: 0, skills: 0, measured: true, input, cached, nonCached: Math.max(0, input - cached), output, total: input + output, aiu });
  }
  return rows;
}

/** Return the summary and signals of the chat Mission Control shows.
 * @param {import('./types').Activity} run
 * @returns {import('./types').Insights | null}
 */
function insights(run) {
  const s = run.session;
  if (!s) return null;
  const { chars, skills, repeats, gap, context } = s.stats;
  const mainActivity = s.stats.main || { turns: s.turns, tools: s.tools, reads: 0, skills: skills.length };
  const measured = run.tokens;
  const sessionAgent = run.meta?.agent || null;
  const sessionModel = run.meta?.model || s.stats.model || (measured?.models[0]?.model ?? null);
  const subagents = buildSubagents(s.stats.subagents || [], run.tokens?.subSpans || [], sessionAgent, sessionModel);
  const skillTokens = tokens(skills.reduce((sum, skill) => sum + skill.bytes, 0));
  const conversation = tokens(chars.user + chars.agent + chars.args);
  const estimatedTurns = (s.stats.subagents || []).length ? mainActivity.turns : s.turns;
  const estimatedInput = estimatedTurns * (BASE_CONTEXT_TOKENS + skillTokens) + Math.round(estimatedTurns * conversation / 2);
  const estimatedOutput = tokens(chars.agent + chars.args);
  const input = measured ? measured.models.reduce((sum, use) => sum + use.input, 0) : estimatedInput;
  const output = measured ? measured.models.reduce((sum, use) => sum + use.output, 0) : estimatedOutput;
  const reasoning = measured ? measured.models.reduce((sum, use) => sum + use.reasoning, 0) : 0;
  const cached = measured ? measured.models.reduce((sum, use) => sum + use.cached, 0) : null;
  const mTok = measured ? (measured.main || { calls: s.turns, input, output, cached: cached || 0, reasoning, peakInput: input, aiu: measured.aiu }) : null;
  const mainNonCached = mTok ? Math.max(0, mTok.input - mTok.cached) : null;
  const stopped = s.events.filter(event => event.state === 'stopped').length;
  const asked = s.events.filter(event => event.kind === 'ask').length;
  const pause = gap ? Math.round((Date.parse(gap.to) - Date.parse(gap.from)) / 1000) : 0;
  /** @type {import('./types').Signal[]} */
  const signals = [
    ...repeats.map(call => ({ tone: /** @type {const} */ ('warn'), title: `Repeated ${call.count} times: ${call.title}`, detail: 'The same call with the same arguments; a possible loop.' })),
    ...(s.failures ? [{ tone: /** @type {const} */ ('error'), title: `${s.failures} failed tool ${s.failures === 1 ? 'call' : 'calls'}`, detail: 'See Problems on the Live page.' }] : []),
    ...(stopped ? [{ tone: /** @type {const} */ ('warn'), title: `${stopped} ${stopped === 1 ? 'call' : 'calls'} never reported a result`, detail: 'Copilot recorded no result; the agent moved on.' }] : []),
    ...(pause >= 120 ? [{ tone: /** @type {const} */ ('info'), title: `Longest pause: ${Math.round(pause / 60)} min`, detail: `Nothing recorded from ${clock(gap?.from)} to ${clock(gap?.to)}: long thinking, a long command, or waiting.` }] : []),
    ...(run.errors?.paused ? [{ tone: /** @type {const} */ ('error'), title: 'Paused by the error guard', detail: `${run.errors.failures.length} failed commands in a row.` }] : []),
    ...(asked ? [{ tone: /** @type {const} */ ('info'), title: `Asked you ${asked} ${asked === 1 ? 'time' : 'times'}`, detail: 'Questions the agent put to you in Chat.' }] : []),
  ];
  const groups = [...context.map(row => ({ group: row.group, count: row.count, tokens: tokens(row.bytes), items: row.items })),
    { group: 'messages', count: 0, tokens: tokens(chars.user + chars.agent), items: [] },
    ...(reasoning ? [{ group: 'thinking', count: 0, tokens: reasoning, items: [] }] : [])].filter(row => row.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const estimatedNonCached = BASE_CONTEXT_TOKENS + groups.filter(row => row.group !== 'thinking').reduce((sum, row) => sum + row.tokens, 0);
  return {
    chat: s.title || 'Untitled chat', measured: !!measured, agent: sessionAgent, model: run.meta?.model || s.stats.model || null, mode: run.meta?.mode || null, context: groups, turns: s.turns, toolCalls: s.tools, commands: s.commands, failures: s.failures,
    skills: { count: skills.length, names: skills.map(skill => skill.name), tokens: skillTokens, allowed: run.loadout ? run.loadout.skills : null },
    chatTokens: tokens(chars.user + chars.agent), argTokens: tokens(chars.args), thinkingTokens: reasoning || null,
    cachedTokens: cached, cachePercent: cached === null || !input ? null : Math.round(cached / input * 100),
    input, output, total: input + output, aiu: measured ? measured.aiu : estimatedInput / 1000 * AIU_PER_1K_INPUT,
    main: { turns: mainActivity.turns, toolCalls: mainActivity.tools, reads: mainActivity.reads, skillReads: mainActivity.skills,
      input: mTok ? mTok.input : null, output: mTok ? mTok.output : null, cached: mTok ? mTok.cached : null, nonCached: mainNonCached,
      cachePercent: mTok && mTok.input ? Math.round(mTok.cached / mTok.input * 100) : null, peakInput: mTok && mTok.peakInput ? mTok.peakInput : null,
      aiu: mTok ? mTok.aiu : null, estimatedNonCached },
    subagents, signals,
    method: measured ? (run.meta?.mode?.startsWith('Copilot') ? 'Measured from this Copilot session.' : 'Measured by research telemetry for this chat.')
      : `Estimated (research telemetry is off): ${BASE_CONTEXT_TOKENS.toLocaleString('en-US')} tokens of instructions and tool definitions plus the skills read, per turn, `
        + `the conversation growing over ${estimatedTurns} main turns, 4 characters per token, and ${AIU_PER_1K_INPUT} AI units per 1,000 input tokens `
        + '(measured on a Claude Opus 5.5 session). Tool results are not in the transcript, so the real figure is higher.',
  };
}

/** Return a compact, numbered log of the chat for an analysis model.
 * @param {import('./types').Activity} run
 * @param {import('./types').Insights} summary
 * @returns {string}
 */
function digest(run, summary) {
  const s = /** @type {import('./types').Session} */ (run.session);
  const steps = s.events.slice(0, DIGEST_STEPS).reverse().map((event, index) =>
    `#${index + 1} ${event.at.slice(11, 19)} ${event.kind}${event.state === 'ok' ? '' : ` [${event.state}]`}: ${event.title}${event.detail ? ` | ${event.detail.slice(0, 160)}` : ''}`);
  return [`Chat: ${summary.chat}`, `Agent ${summary.agent || 'unknown'}, model ${summary.model || 'unknown'}, ${summary.mode || 'unknown'} session.`,
    `Context: ${summary.context.map(row => `${row.group} ${row.count ? `${row.count} calls, ` : ''}~${row.tokens} tokens`).join('; ')}.`, `Turns ${s.turns}, tool calls ${s.tools}, commands ${s.commands}, failed ${s.failures}, skills read: ${summary.skills.names.join(', ') || 'none'}.`,
    s.todos.length ? `To-do list: ${s.todos.map(todo => `${todo.title} (${todo.status})`).join('; ')}` : '',
    run.errors?.failures.length ? `Error guard: ${run.errors.paused ? 'paused after ' : ''}${run.errors.failures.map(failure => failure.command).join(' ; ')}` : '',
    summary.signals.length ? `Signals: ${summary.signals.map(signal => signal.title).join('; ')}` : '',
    `Steps, oldest first (last ${steps.length}):`, ...steps].filter(Boolean).join('\n');
}

/** Return the instruction for the analysis model.
 * @param {string} question
 * @param {string} log
 * @returns {string}
 */
function analysisPrompt(question, log) {
  return ['You review one AI coding-agent chat from its activity log below. Look for thinking errors (wrong assumptions, errors it ignored), '
    + 'circular or repeated tool calls, places it got stuck and looped, and decisions it made without asking the user. Use only what the log shows.',
  'Reply with exactly 3 bullets, each one crisp sentence that cites step numbers (#n). If the log shows nothing for a point, say so plainly.',
  `The user asks: ${question}`, '', log].join('\n');
}

module.exports = { insights, digest, analysisPrompt, otelUsage, BASE_CONTEXT_TOKENS, AIU_PER_1K_INPUT };
