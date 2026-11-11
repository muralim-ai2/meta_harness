'use strict';
/** Verify companion mode: when Claude Code, Codex, Cursor or Copilot CLI works on the open ask, Mission Control says so, offers the start
 * command, and copies messages for the agent instead of opening Copilot Chat. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { workspace, removeWorkspace } = require('./helpers');
const { mission } = require('./vscode-stub');
const { listAsks } = require('../../extension/ui/asks');
const { companion } = require('../../extension/ui/companion');
const { text } = require('../../extension/ui/media/vnode');
const { sidebar } = require('../../extension/ui/media/views');
const UI = { page: 'live', filter: 'all', open: {}, seq: 0 };
const NOW = Date.parse('2026-11-10T12:00:00.000Z');

/** Write the open-ask pointer and the record of the tool that last ran hooks.
 * @param {string} root
 * @param {string} client
 * @param {string} ts
 * @returns {void}
 */
function recordTool(root, client, ts) {
  fs.mkdirSync(path.join(root, '.aria', 'asks'), { recursive: true });
  fs.mkdirSync(path.join(root, '.aria', 'runs'), { recursive: true });
  if (!fs.existsSync(path.join(root, '.aria', 'asks', 'active.json'))) {
    fs.writeFileSync(path.join(root, '.aria', 'asks', 'active.json'), JSON.stringify({ active: '20261110-1100-leave' }));
  }
  fs.writeFileSync(path.join(root, '.aria', 'runs', 'client.json'), JSON.stringify({ client, session: 's1', ts }));
}

test('the tool shows only for an open ask, in the last two hours, and when no chat of this window is newer', t => {
  const root = workspace();
  t.after(() => removeWorkspace(root));
  assert.equal(companion(root, [], NOW), null);
  recordTool(root, 'claude', '2026-11-10T11:30:00+00:00');
  assert.deepEqual(companion(root, [], NOW), { client: 'claude', label: 'Claude Code', start: 'claude --agent aria-lite', at: '2026-11-10T11:30:00+00:00' });
  assert.equal(companion(root, [/** @type {any} */ ({ lastAt: '2026-11-10T11:45:00.000Z' })], NOW), null, 'a newer Copilot chat wins');
  assert.equal(companion(root, [], NOW + 3 * 3_600_000), null, 'an old record lapses');
  fs.rmSync(path.join(root, '.aria', 'asks', 'active.json'));
  assert.equal(companion(root, [], NOW), null, 'no open ask: no tool');
  recordTool(root, 'notepad', '2026-11-10T11:30:00+00:00');
  assert.throws(() => companion(root, [], NOW), /Invalid tool record/);
});

test('Mission Control names the tool, copies its start command, and copies messages for the agent instead of opening Copilot Chat', async t => {
  const fixture = mission(t);
  fixture.controls.inputs.push('Leave portal', 'Build a leave portal with approvals');
  fixture.controls.confirmations.push('Create ask');
  await fixture.controls.commands.get('frontierHve.newAsk')();
  const ask = listAsks(fixture.root).find(row => row.active);
  assert.ok(ask);
  fs.mkdirSync(path.join(fixture.root, '.aria', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, '.aria', 'runs', 'client.json'), JSON.stringify({ client: 'codex', session: 's1', ts: new Date().toISOString() }));
  await fixture.controls.commands.get('frontierHve.refreshMissionControl')();
  const model = fixture.controls.commands.get('frontierHve.missionControlModel')();
  assert.equal(model.companion.label, 'Codex');
  assert.match(text(sidebar({ ...model, surface: 'sidebar' }, UI, Date.now())), /Working in Codex \(last step just now\)/);
  await fixture.controls.provider.execute({ action: 'copyCompanionStart' });
  assert.deepEqual(fixture.controls.calls.filter(call => call[0] === 'clipboard').at(-1), ['clipboard', 'codex, then $aria-lite']);
  const before = fixture.controls.calls.length;
  await fixture.load(path.join('ui', 'ask-flow.js')).messageInChat(fixture.controls.provider, ask.id, 'Please add a manager approval step');
  const after = fixture.controls.calls.slice(before);
  assert.deepEqual(after.find(call => call[0] === 'clipboard'), ['clipboard', 'Please add a manager approval step']);
  assert.ok(!after.some(call => String(call[0]).startsWith('workbench.action.chat')), 'Copilot Chat is not opened');
  assert.match(after.find(call => call[0] === 'information')[1], /worked on in Codex/);
});
