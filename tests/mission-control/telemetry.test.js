'use strict';
/** Verify the Telemetry page: the chat's numbers measured or estimated, local signals, and the experimental model review streamed from a Copilot model. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mission } = require('./vscode-stub');
const { insights, digest, analysisPrompt } = require('../../extension/ui/insights');
const { activity } = require('../../extension/ui/activity');
const { text } = require('../../extension/ui/media/vnode');
const { dashboard } = require('../../extension/ui/media/pages');
const { message } = require('../../extension/ui/validate');
const UI = { page: 'telemetry', filter: 'all', open: {}, seq: 0 };

/** Write a chat that reads two skills, repeats one search three times and fails a command.
 * @param {string} folder
 * @param {string} root
 * @returns {string}
 */
function chat(folder, root) {
  fs.mkdirSync(folder, { recursive: true });
  const skill = path.join(root, 'skills', 'ux-flows', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, 'x'.repeat(4000));
  const start = Date.now() - 10 * 60_000;
  const at = seconds => new Date(start + seconds * 1000).toISOString();
  const rows = [['user.message', 0, { content: 'Build the Pawstagram feed with dog profiles' }], ['assistant.turn_start', 1, {}],
    ['tool.execution_start', 2, { toolCallId: 'a', toolName: 'read_file', arguments: { filePath: skill } }], ['tool.execution_complete', 3, { toolCallId: 'a', success: true }],
    ...[10, 20, 30].flatMap((s, i) => [['tool.execution_start', s, { toolCallId: `g${i}`, toolName: 'grep_search', arguments: { query: 'feedCard' } }],
      ['tool.execution_complete', s + 1, { toolCallId: `g${i}`, success: true }]]),
    ['tool.execution_start', 40, { toolCallId: 'r', toolName: 'run_in_terminal', arguments: { command: 'npm test', explanation: 'Run the feed checks' } }],
    ['tool.execution_complete', 300, { toolCallId: 'r', success: false }], ['assistant.message', 301, { content: 'The feed check failed; fixing the card layout.' }],
    ['assistant.turn_end', 301, {}]];
  const file = path.join(folder, 'feed.jsonl');
  fs.writeFileSync(file, rows.map(([type, s, data]) => JSON.stringify({ type, timestamp: at(s), data }) + '\n').join(''));
  return file;
}

test('without telemetry the summary estimates tokens and AI units, counts calls, turns and skills, and finds repeats, failures and pauses', t => {
  const fixture = mission(t);
  const file = chat(fixture.transcripts, fixture.root);
  const run = { ...activity(fixture.root, file, null, Date.now()), chats: [] };
  const data = insights(run);
  assert.equal(data.measured, false);
  assert.equal(data.turns, 1);
  assert.equal(data.toolCalls, 5);
  assert.equal(data.failures, 1);
  assert.deepEqual(data.skills, { count: 1, names: ['ux-flows'], tokens: 1000, allowed: null });
  assert.equal(data.thinkingTokens, null);
  assert.deepEqual([data.cachedTokens, data.cachePercent], [null, null]);
  assert.ok(data.total > 12000 && data.aiu > 1);
  assert.match(data.method, /^Estimated \(research telemetry is off\)/);
  assert.deepEqual(data.signals.map(signal => signal.title), ['Repeated 3 times: Searched for “feedCard”', '1 failed tool call', 'Longest pause: 4 min']);
  const log = digest(run, data);
  assert.match(log, /^Chat: Build the Pawstagram feed with dog profiles/);
  assert.match(log, /#\d+ \d\d:\d\d:\d\d run \[failed\]: Run the feed checks \| npm test/);
  assert.match(analysisPrompt('Why did it fail?', log), /exactly 3 bullets[\s\S]*The user asks: Why did it fail\?/);
});

test('with research telemetry the totals, AI units and thinking tokens are measured', () => {
  const run = { session: { title: 'Feed', turns: 2, tools: 3, commands: 1, failures: 0, events: [], todos: [],
    stats: { chars: { user: 400, agent: 400, args: 400 }, skills: [], repeats: [], gap: null, context: [] } }, chats: [], errors: null,
  meta: { agent: 'ARIA Collab', model: 'claude-haiku-5.5', mode: 'Local' },
  loadout: { skills: 4, tokens: 9000, overBudget: false, maxSkills: 10, maxTokens: 32000 },
  tokens: { models: [{ model: 'claude-haiku-5.5', calls: 2, failed: 0, input: 50000, output: 2000, cached: 30000, reasoning: 1500 }], aiu: 2.5 } };
  const data = insights(run);
  assert.equal(data.measured, true);
  assert.deepEqual([data.input, data.output, data.total, data.aiu, data.thinkingTokens], [50000, 2000, 52000, 2.5, 1500]);
  assert.deepEqual([data.cachedTokens, data.cachePercent], [30000, 60]);
  assert.deepEqual(data.skills, { count: 0, names: [], tokens: 0, allowed: 4 }, 'four skills allowed, none read: the chat used none');
  assert.equal(data.method, 'Measured by research telemetry for this chat.');
  assert.deepEqual([data.agent, data.model, data.mode], ['ARIA Collab', 'claude-haiku-5.5', 'Local']);
  assert.deepEqual(data.context.map(row => row.group), ['thinking', 'messages']);
});

test('the Telemetry tab shows the chat\'s agent, mode and model, the tiles, the experimental review with standard questions and what fills the context, totals only when measured', async t => {
  const fixture = mission(t);
  chat(fixture.transcripts, fixture.root);
  fixture.controls.models.push({ id: 'claude-haiku-5.5', name: 'Claude Haiku 5.5', family: 'claude-haiku', sendRequest: async () => ({ text: (async function* () {})() }) },
    { id: 'gpt-6-astra', name: 'GPT-6 Astra', family: 'gpt-6' });
  await fixture.controls.provider.execute({ action: 'loadModels' });
  const model = fixture.controls.commands.get('frontierHve.missionControlModel')();
  assert.deepEqual(model.models.map(row => row.name), ['Claude Haiku 5.5', 'GPT-6 Astra']);
  const page = dashboard(model, UI, Date.now());
  const shown = text(page);
  for (const part of ['Telemetry · one chat', 'agent not recorded', 'execution mode not recorded', 'Total tokens and AI units appear for chats recorded with research telemetry on',
    'Turns', 'Tool calls', 'Skills used', 'Skill tokens', 'Prompt and chat tokens', 'Thinking tokens', 'Cache tokens', 'Ask a model about this chat', 'Experimental',
    'Did the agent start sub-agents to explore different paths', 'My own question…', 'What fills the context window', 'Skills loaded', 'Searches', 'Commands']) {
    assert.ok(shown.includes(part), part);
  }
  assert.ok(!shown.includes('tokens in total'));
  assert.ok(!/≈/.test(shown));
  assert.ok(!shown.includes('Signals'));
  const find = (node, match) => typeof node === 'string' ? [] : [...(match(node) ? [node] : []), ...node.children.flatMap(child => find(child, match))];
  const tiles = find(page, node => node.attrs.class?.startsWith('tele-tile tone-'));
  assert.deepEqual(tiles.map(node => [node.tag, node.attrs['data-page'] || null, node.attrs['data-filter'] || null]),
    [['button', 'live', 'conversation'], ['button', 'live', 'problems'], ['button', 'skills', null], ['button', 'skills', null], ['button', 'live', 'conversation'],
      ['div', null, null], ['div', null, null]], 'tiles with a destination are buttons; the rest are plain and have no hover');
  const options = find(find(page, node => node.tag === 'select' && node.attrs['data-field'] === 'model')[0], node => node.tag === 'option');
  assert.deepEqual(options.filter(node => 'selected' in node.attrs).map(node => node.attrs.value), ['claude-haiku-5.5']);
  assert.equal(find(page, node => node.tag === 'textarea').length, 0);
  assert.equal(find(dashboard(model, { ...UI, preset: 'custom' }, Date.now()), node => node.tag === 'textarea').length, 1);
  assert.equal(find(page, node => node.attrs['data-action'] === 'analyze').length, 1);
});

test('Analyze streams the model\'s three bullets into the page and sends only the chat\'s log', async t => {
  const fixture = mission(t);
  chat(fixture.transcripts, fixture.root);
  /** @type {any[]} */
  const sent = [];
  fixture.controls.models.push({ id: 'claude-haiku-5.5', name: 'Claude Haiku 5.5', family: 'claude-haiku', sendRequest: async (messages, options) => {
    sent.push({ messages, options });
    return { text: (async function* () { yield '- Repeated the same search three times (#4-#6).\n'; yield '- Ignored nothing.\n- Decided the layout alone (#9).'; })() };
  } });
  await fixture.controls.commands.get('frontierHve.refreshMissionControl')();
  await fixture.controls.provider.execute({ action: 'analyze', model: 'claude-haiku-5.5', question: 'Where did it loop?' });
  const result = fixture.controls.commands.get('frontierHve.missionControlModel')().analysis;
  assert.equal(result.status, 'done');
  assert.equal(result.model, 'Claude Haiku 5.5');
  assert.match(result.text, /^- Repeated the same search three times/);
  assert.match(sent[0].messages[0].content, /The user asks: Where did it loop\?/);
  assert.match(sent[0].messages[0].content, /Steps, oldest first/);
  assert.match(sent[0].options.justification, /at your request/);
  const page = text(dashboard(fixture.controls.commands.get('frontierHve.missionControlModel')(), UI, Date.now()));
  assert.match(page, /Repeated the same search three times \(#4-#6\)/);
  await assert.rejects(fixture.controls.provider.execute({ action: 'analyze', model: 'missing', question: 'x' }), /model missing is not available/);
  assert.throws(() => message({ action: 'analyze', model: 'x' }), /Unexpected fields/);
});

test('without Copilot models the page says so instead of failing', async t => {
  const fixture = mission(t);
  chat(fixture.transcripts, fixture.root);
  await fixture.controls.provider.execute({ action: 'loadModels' });
  const model = fixture.controls.commands.get('frontierHve.missionControlModel')();
  assert.match(model.modelsError, /No Copilot models are available/);
  assert.match(text(dashboard(model, UI, Date.now())), /No Copilot models are available/);
});

test('Copilot mode sessions in ~/.copilot/session-state update Live and measured Telemetry without copilot-otel.jsonl', async t => {
  const copilotState = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'aria-cop-'));
  process.env.HVE_COPILOT_SESSIONS = copilotState;
  t.after(() => { delete process.env.HVE_COPILOT_SESSIONS; fs.rmSync(copilotState, { recursive: true, force: true }); });
  const fixture = mission(t);
  const askId = '20261111-1046-efficiency-check';
  const askDir = path.join(fixture.root, '.aria', 'asks', askId);
  fs.mkdirSync(path.join(askDir, 'loop'), { recursive: true });
  fs.mkdirSync(path.join(fixture.root, '.aria', 'project'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, '.aria', 'asks', 'active.json'), JSON.stringify({ active: askId }));
  fs.writeFileSync(path.join(askDir, 'request.md'), 'Efficiency check\n');
  fs.writeFileSync(path.join(askDir, 'contract.json'), JSON.stringify({
    ask: askId, slug: 'efficiency-check', request: 'Efficiency check', lifecycle: 'direct', source: 'builtin', agent: 'ARIA Lite',
    created: '2026-11-11T10:46:00Z', current: 'deliver', scope: [], for_stage: null, gates: 'all', packs: [],
    paths: { ask: `.aria/asks/${askId}`, plan: `.aria/asks/${askId}/plan.md`, loop: `.aria/asks/${askId}/loop`,
      evidence: `.aria/asks/${askId}/loop/evidence`, project: '.aria/project', feature_list: '.aria/project/feature_list.json',
      feature_list_add: '.aria/project/feature_list.add.json' },
    stages: [{ name: 'deliver', goal: 'Deliver', agent: 'self', skills: [], plugin_skills: [], templates: [], exit: 'Done', status: 'active', note: '' }],
    skills: { selected: [], tokens: 0, over_budget: false, budget: { max_skills: 10, max_tokens: 32000 }, suggested: [], suggested_tokens: 0, choice: null, plugin: {} },
    personas: [], tasks: [], environment: { mcp_servers: [], hook_files: [], tool_load: { harnesses: {}, warn_tokens: 6000, warnings: [] } },
    delegations: [], reported: [], plan: { sha256: null, revisions: [] }, checklist: {}, checklist_rendered: {}, decisions: [],
  }));
  const skillFile = path.join(fixture.root, '.aria', 'skills', 'delivery-coach', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, 's'.repeat(2000));
  const sid = '516ba980-c063-4201-b3d7-037dab6de2f8';
  const sessionDir = path.join(copilotState, sid);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), `id: ${sid}\ncwd: ${fixture.root}\nclient_name: vscode-agent-host\n`);
  const now = Date.now();
  const iso = s => new Date(now - (30 - s) * 1000).toISOString();
  const events = [
    ['session.start', 0, { sessionId: sid, startTime: iso(0), selectedModel: 'gpt-6.1-sol' }],
    ['user.message', 1, { content: `Build tracker. If you are an agent that uses .aria or .harness folders, work in the ask .aria/asks/${askId}` }],
    ['assistant.turn_start', 2, { turnId: '0' }],
    ['session.usage_record', 3, { usage: { model: 'gpt-6.1-sol', responseModel: 'gpt-6.1-sol', inputTokens: 28000, outputTokens: 500,
      cacheReadTokens: 21000, reasoningTokens: 400, copilotUsage: { totalNanoAiu: 3_500_000_000 } } }],
    ['tool.execution_start', 4, { toolCallId: 'c1', toolName: 'skill', arguments: { skill: 'delivery-coach' } }],
    ['skill.invoked', 4, { name: 'delivery-coach', path: skillFile }],
    ['tool.execution_complete', 5, { toolCallId: 'c1', success: true }],
    ['tool.execution_start', 6, { toolCallId: 'c2', toolName: 'powershell', arguments: { command: 'node --test', description: 'Run unit tests' } }],
  ];
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), events.map(([type, s, data]) => JSON.stringify({ type, timestamp: iso(s), data }) + '\n').join(''));
  await fixture.controls.commands.get('frontierHve.refreshMissionControl')();
  const model = fixture.controls.commands.get('frontierHve.missionControlModel')();
  assert.equal(model.activity.session.id, sid);
  assert.equal(model.activity.session.status, 'working');
  assert.equal(model.activity.session.current.title, 'Run unit tests');
  assert.equal(model.insights.measured, true);
  assert.equal(model.insights.mode, 'Copilot');
  assert.equal(model.insights.agent, 'ARIA Lite');
  assert.equal(model.insights.model, 'gpt-6.1-sol');
  assert.deepEqual([model.insights.input, model.insights.output, model.insights.total, model.insights.cachedTokens, model.insights.cachePercent, model.insights.thinkingTokens, model.insights.aiu],
    [28000, 500, 28500, 21000, 75, 400, 3.5]);
  assert.deepEqual(model.insights.skills.names, ['delivery-coach']);
});

test('Telemetry separates main-agent non-cached tokens and peak prompt from per-subagent token and AIU breakdown', async t => {
  const fixture = mission(t);
  const sid = 'sub-split-1';
  const start = Date.now() - 60_000;
  const iso = s => new Date(start + s * 1000).toISOString();
  const hr = s => [Math.floor((start + s * 1000) / 1000), ((start + s * 1000) % 1000) * 1e6];
  const fileA = path.join(fixture.root, 'server.js');
  fs.writeFileSync(fileA, 'x'.repeat(8000));
  const rows = [
    ['session.start', 0, { sessionId: sid, startTime: iso(0) }],
    ['user.message', 1, { content: 'Build leave tracker' }],
    ['assistant.turn_start', 2, { turnId: '0' }],
    ['tool.execution_start', 3, { toolCallId: 'm1', toolName: 'read_file', arguments: { filePath: fileA, startLine: 1, endLine: 20 } }],
    ['tool.execution_complete', 4, { toolCallId: 'm1', success: true }],
    ['tool.execution_start', 5, { toolCallId: 'sub1', toolName: 'runSubagent', arguments: { agentName: 'aria-engineer', description: 'Build domain' } }],
    ['assistant.turn_start', 6, { turnId: 's0' }],
    ['tool.execution_start', 7, { toolCallId: 'sr1', toolName: 'read_file', arguments: { filePath: fileA } }],
    ['tool.execution_complete', 8, { toolCallId: 'sr1', success: true }],
    ['tool.execution_complete', 15, { toolCallId: 'sub1', success: true }],
    ['assistant.message', 16, { content: 'Domain verified.' }],
    ['assistant.turn_end', 17, {}],
  ];
  const tFile = path.join(fixture.transcripts, `${sid}.jsonl`);
  fs.mkdirSync(fixture.transcripts, { recursive: true });
  fs.writeFileSync(tFile, rows.map(([type, s, data]) => JSON.stringify({ type, timestamp: iso(s), data }) + '\n').join(''));
  const otel = path.join(fixture.root, '.aria', 'runs', 'copilot-otel.jsonl');
  fs.mkdirSync(path.dirname(otel), { recursive: true });
  const spans = [
    { name: 'chat claude-opus-5.5', startTime: hr(2), endTime: hr(4), attributes: { 'copilot_chat.chat_session_id': sid,
      'gen_ai.response.model': 'claude-opus-5.5', 'gen_ai.usage.input_tokens': 30000, 'gen_ai.usage.cache_read.input_tokens': 24000,
      'gen_ai.usage.output_tokens': 400, 'copilot_chat.copilot_usage_nano_aiu': 2_000_000_000 } },
    { name: 'chat claude-opus-5.5', startTime: hr(15), endTime: hr(17), attributes: { 'copilot_chat.chat_session_id': sid,
      'gen_ai.response.model': 'claude-opus-5.5', 'gen_ai.usage.input_tokens': 42000, 'gen_ai.usage.cache_read.input_tokens': 38000,
      'gen_ai.usage.output_tokens': 300, 'copilot_chat.copilot_usage_nano_aiu': 2_500_000_000 } },
    { name: 'chat gpt-5.6-luna', startTime: hr(6), endTime: hr(14), attributes: { 'copilot_chat.chat_session_id': 'child-1',
      'copilot_chat.parent_chat_session_id': sid, 'gen_ai.response.model': 'gpt-5.6-luna', 'gen_ai.usage.input_tokens': 12000,
      'gen_ai.usage.cache_read.input_tokens': 9000, 'gen_ai.usage.output_tokens': 600, 'copilot_chat.copilot_usage_nano_aiu': 500_000_000 } },
  ];
  fs.writeFileSync(otel, spans.map(s => JSON.stringify(s) + '\n').join(''));
  fixture.controls.settings.set('github.copilot.chat.otel.enabled', true);
  fixture.controls.settings.set('github.copilot.chat.otel.outfile', otel);
  await fixture.controls.commands.get('frontierHve.refreshMissionControl')();
  const model = fixture.controls.commands.get('frontierHve.missionControlModel')();
  const ins = model.insights;
  assert.deepEqual([ins.main.turns, ins.main.reads, ins.main.input, ins.main.cached, ins.main.nonCached, ins.main.peakInput, ins.main.aiu],
    [1, 1, 72000, 62000, 10000, 42000, 4.5]);
  assert.equal(ins.subagents.length, 1);
  assert.deepEqual([ins.subagents[0].name, ins.subagents[0].task, ins.subagents[0].model, ins.subagents[0].turns, ins.subagents[0].reads,
    ins.subagents[0].nonCached, ins.subagents[0].total, ins.subagents[0].aiu, ins.subagents[0].state],
    ['aria-engineer', 'Build domain', 'gpt-5.6-luna', 1, 1, 3000, 12600, 0.5, 'ok']);
  const rendered = text(dashboard(model, UI, Date.now()));
  assert.match(rendered, /10kmain non-cached input tokens/);
  assert.match(rendered, /Main agent · Non-cached tokensMeasured10knon-cached input tokens billed to the main agent window/);
  assert.match(rendered, /Main peak prompt: 42k · Main AIU: 4\.50/);
  assert.match(rendered, /Sub-agents · 1 run[\s\S]*aria-engineer[\s\S]*Build domain[\s\S]*gpt-5\.6-luna[\s\S]*1 turn · 1 tool[\s\S]*1 read · 0 skill[\s\S]*0\.50[\s\S]*ok/);
  assert.doesNotMatch(rendered, /Non-cached \/ total|isolated window/);
});

test('Sub-agent table resolves agent and model from brief delegations, tool arguments and session model without isolated-window column', async t => {
  const fixture = mission(t);
  const askId = '20261111-1902-elevate-design';
  const askDir = path.join(fixture.root, '.aria', 'asks', askId);
  fs.mkdirSync(path.join(askDir, 'loop'), { recursive: true });
  fs.mkdirSync(path.join(fixture.root, '.aria', 'project'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, '.aria', 'asks', 'active.json'), JSON.stringify({ active: askId }));
  fs.writeFileSync(path.join(askDir, 'request.md'), 'Elevate design\n');
  fs.writeFileSync(path.join(askDir, 'contract.json'), JSON.stringify({
    ask: askId, slug: 'elevate-design', request: 'Elevate design', lifecycle: 'direct', source: 'builtin', agent: 'ARIA Lite',
    created: '2026-11-11T19:02:00Z', current: 'deliver', scope: [], for_stage: null, gates: 'all', packs: [],
    paths: { ask: `.aria/asks/${askId}`, plan: `.aria/asks/${askId}/plan.md`, loop: `.aria/asks/${askId}/loop`,
      evidence: `.aria/asks/${askId}/loop/evidence`, project: '.aria/project', feature_list: '.aria/project/feature_list.json',
      feature_list_add: '.aria/project/feature_list.add.json' },
    stages: [{ name: 'deliver', goal: 'Deliver', agent: 'self', skills: [], plugin_skills: [], templates: [], exit: 'Done', status: 'active', note: '' }],
    skills: { selected: [], tokens: 0, over_budget: false, budget: { max_skills: 10, max_tokens: 32000 }, suggested: [], suggested_tokens: 0, choice: null, plugin: {} },
    personas: [], tasks: [], environment: { mcp_servers: [], hook_files: [], tool_load: { harnesses: {}, warn_tokens: 6000, warnings: [] } },
    delegations: [{ ts: '2026-11-11T19:13:28Z', persona: 'frontend', stage: 'deliver', task: 'glass-theme', skills: [] }],
    reported: [], plan: { sha256: null, revisions: [] }, checklist: {}, checklist_rendered: {}, decisions: [],
  }));
  const sid = 'sub-resolve-1';
  const start = Date.now() - 40_000;
  const iso = s => new Date(start + s * 1000).toISOString();
  const rows = [
    ['session.start', 0, { sessionId: sid, startTime: iso(0), selectedModel: 'claude-opus-5.5' }],
    ['user.message', 1, { content: `Work in the ask .aria/asks/${askId}` }],
    ['assistant.turn_start', 2, { turnId: '0' }],
    ['tool.execution_start', 3, { toolCallId: 's1', toolName: 'runSubagent', arguments: {
      description: 'Build glass-theme restyle',
      prompt: `Frontier HVE brief: ask ${askId}, stage deliver, task glass-theme\n- Stage goal: Deliver`,
    } }],
    ['assistant.turn_start', 4, { turnId: 's1-0' }],
    ['tool.execution_complete', 5, { toolCallId: 's1', success: true }],
    ['tool.execution_start', 6, { toolCallId: 's2', toolName: 'runSubagent', arguments: {
      description: 'Council critical review', model: 'GPT-5 (copilot)',
      prompt: 'You are a read-only output-evaluation reviewer.',
    } }],
    ['tool.execution_complete', 7, { toolCallId: 's2', success: false }],
    ['assistant.turn_end', 8, {}],
  ];
  fs.mkdirSync(fixture.transcripts, { recursive: true });
  fs.writeFileSync(path.join(fixture.transcripts, `${sid}.jsonl`), rows.map(([type, s, data]) => JSON.stringify({ type, timestamp: iso(s), data }) + '\n').join(''));
  await fixture.controls.commands.get('frontierHve.refreshMissionControl')();
  const model = fixture.controls.commands.get('frontierHve.missionControlModel')();
  assert.deepEqual(model.insights.subagents.map(r => [r.name, r.model, r.state]), [
    ['frontend', 'claude-opus-5.5', 'ok'],
    ['evaluation-reviewer', 'GPT-5', 'failed'],
  ]);
  const rendered = text(dashboard(model, UI, Date.now()));
  assert.match(rendered, /Main agent · Non-cached tokensEstimated/);
  assert.doesNotMatch(rendered, /isolated window|Non-cached \/ total/);
});
