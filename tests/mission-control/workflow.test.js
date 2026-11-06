'use strict';
/** Verify Mission Control's confirmed ask, review and new-chat actions end to end through its commands and the bundled runtime. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mission } = require('./vscode-stub');
const { snapshot } = require('../../extension/ui/workspace-state');

/** Create a real ask through the New ask command, renamed and confirmed by the user.
 * @param {ReturnType<typeof mission>} fixture
 * @param {string} slug
 * @returns {Promise<import('../../extension/ui/types').Snapshot>}
 */
async function create(fixture, slug) {
  fixture.controls.inputs.push('Onboarding policy checker', 'Build an onboarding policy checker', slug);
  fixture.controls.confirmations.push('Change folder name…', 'Create ask');
  await fixture.controls.commands.get('frontierHve.newAsk')();
  return snapshot(fixture.root);
}

test('new ask creates a real ask only after a confirmation, then opens an empty new chat for it', async t => {
  const fixture = mission(t);
  const state = await create(fixture, 'onboarding');
  assert.match(state.ask.id, /-onboarding$/);
  assert.equal(state.ask.agent, 'ARIA Lite');
  assert.ok(fixture.controls.calls.some(call => call[0] === 'confirmation' && call[1].includes(path.basename(fixture.root))));
  const chat = fixture.controls.calls.filter(call => String(call[0]).startsWith('workbench.action.chat.'));
  assert.deepEqual(chat.map(call => call[0]), ['workbench.action.chat.open', 'workbench.action.chat.newLocalChat', 'workbench.action.chat.open']);
  assert.equal(chat[2][1].isPartialQuery, true);
  assert.equal(fixture.context.workspaceState.get('pendingChat').ask, state.ask.id);
  assert.deepEqual(fs.readdirSync(fixture.storage), []);
});

test('cancelled creation does not modify the target project', async t => {
  const fixture = mission(t);
  fixture.controls.inputs.push('Onboarding policy checker');
  await fixture.controls.commands.get('frontierHve.newAsk')();
  await fixture.controls.commands.get('frontierHve.newAsk')();
  assert.deepEqual(fs.readdirSync(fixture.root), []);
});

test('requested changes persist through the guarded API and the new ask opens on Live', async t => {
  const fixture = mission(t);
  const state = await create(fixture, 'review');
  assert.deepEqual(fixture.controls.commands.get('frontierHve.missionControlModel')().navigate, { page: 'live', seq: 1 });
  fixture.controls.inputs.push('Clarify the policy acceptance criteria.');
  fixture.controls.confirmations.push('Request changes');
  await fixture.controls.provider.execute({ action: 'review', item: 'stage:deliver', value: 'changes', revision: state.revision });
  const saved = snapshot(fixture.root);
  assert.equal(saved.reviews[0].decision, 'changes');
  assert.equal(saved.reviews[0].note, 'Clarify the policy acceptance criteria.');
});

test('accepting unfinished work is refused before any confirmation or write', async t => {
  const fixture = mission(t);
  const state = await create(fixture, 'unfinished');
  const seen = fixture.controls.calls.length;
  await assert.rejects(fixture.controls.provider.execute({ action: 'review', item: 'stage:deliver', value: 'accepted', revision: state.revision }),
    /Acceptance requires/);
  assert.equal(snapshot(fixture.root).revision, state.revision);
  assert.ok(!fixture.controls.calls.slice(seen).some(call => call[0] === 'confirmation'));
});

test('without a written plan the user can mark the stage done to match the chat, then accept it; the journal shows on the snapshot', async t => {
  const fixture = mission(t);
  const state = await create(fixture, 'markdone');
  assert.equal(state.planState, 'missing');
  assert.equal(state.reviews[0].status, 'planned');
  fixture.controls.inputs.push('Checker built and verified in the chat.');
  fixture.controls.confirmations.push('Mark done');
  await fixture.controls.provider.execute({ action: 'markDone', item: 'stage:deliver', revision: state.revision });
  const done = snapshot(fixture.root);
  assert.equal(done.reviews[0].status, 'done');
  assert.equal(done.decisions.at(-1).why, 'Checker built and verified in the chat.');
  fixture.controls.inputs.push('Ran the checker on two policies.');
  fixture.controls.confirmations.push('Accept');
  await fixture.controls.provider.execute({ action: 'review', item: 'stage:deliver', value: 'accepted', revision: done.revision });
  assert.equal(snapshot(fixture.root).reviews[0].decision, 'accepted');
  await assert.rejects(fixture.controls.provider.execute({ action: 'markDone', item: 'stage:deliver', revision: snapshot(fixture.root).revision }),
    /Only a planned or active stage/);
  fs.appendFileSync(path.join(fixture.root, '.aria', 'project', 'journal.jsonl'), JSON.stringify({ ts: '2026-11-06T10:00:00+00:00', ask: state.ask.id,
    stage: 'deliver', kind: 'pitfall', text: 'The policy files use Windows line endings', why: 'the parser split on \\n only' }) + '\n');
  assert.deepEqual(snapshot(fixture.root).journal.map(row => [row.kind, row.text]), [['pitfall', 'The policy files use Windows line endings']]);
});

test('a stale view cannot record a review after the project changes', async t => {
  const fixture = mission(t);
  const state = await create(fixture, 'stale');
  fs.appendFileSync(path.join(fixture.root, '.aria', 'asks', state.ask.id, 'plan.md'), '\nAnother requirement.');
  await assert.rejects(fixture.controls.provider.execute({ action: 'review', item: 'stage:deliver', value: 'changes', revision: state.revision }),
    /state changed/);
  assert.equal(snapshot(fixture.root).reviews[0].decision, 'open');
});
