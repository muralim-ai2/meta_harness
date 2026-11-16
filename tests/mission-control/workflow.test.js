'use strict';
/** Verify Mission Control's confirmed ask, review and new-chat actions end to end through its commands and the bundled runtime. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mission } = require('./vscode-stub');
const { snapshot } = require('../../extension/ui/workspace-state');
const { text } = require('../../extension/ui/media/vnode');
const { dashboard } = require('../../extension/ui/media/pages');

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
  fixture.controls.confirmations.push('Refine');
  await fixture.controls.provider.execute({ action: 'review', item: 'stage:deliver', value: 'changes', revision: state.reviews[0].revision });
  const saved = snapshot(fixture.root);
  assert.equal(saved.reviews[0].decision, 'changes');
  assert.equal(saved.reviews[0].note, 'Clarify the policy acceptance criteria.');
});

test('Refine on a done stage reopens it and hands the request to the ask\'s agent in Chat; the stage links the files and decisions to review', async t => {
  const fixture = mission(t);
  const state = await create(fixture, 'changes');
  fs.mkdirSync(path.join(fixture.root, 'docs'));
  fs.writeFileSync(path.join(fixture.root, 'docs', 'policy.md'), '# Policy\n');
  fixture.controls.inputs.push('Built docs/policy.md and checked it in the chat.');
  fixture.controls.confirmations.push('Mark done');
  await fixture.controls.provider.execute({ action: 'markDone', item: 'stage:deliver', revision: state.reviews[0].revision });
  const done = snapshot(fixture.root);
  assert.equal(done.reviews[0].ready, true);
  assert.ok(done.reviews[0].files.includes(path.join('docs', 'policy.md')), 'a file the stage note names is linked for review');
  const seen = fixture.controls.calls.length;
  fixture.controls.inputs.push('Add a review stage before delivery');
  fixture.controls.confirmations.push('Refine');
  await fixture.controls.provider.execute({ action: 'review', item: 'stage:deliver', value: 'changes', revision: done.reviews[0].revision });
  const after = snapshot(fixture.root);
  assert.deepEqual([after.reviews[0].decision, after.reviews[0].status, after.reviews[0].ready], ['changes', 'active', false]);
  const calls = fixture.controls.calls.slice(seen);
  assert.match(calls.find(call => call[0] === 'input')[1].title, /Refine stage:deliver: what should change\?/);
  assert.match(calls.find(call => call[0] === 'confirmation')[2].detail, /sets the stage back to active and opens the ask's chat/);
  const chat = calls.filter(call => call[0] === 'workbench.action.chat.open').at(-1)[1];
  assert.equal(chat.isPartialQuery, true, 'filled in, never sent for the user');
  assert.equal(chat.mode, 'ARIA Lite');
  assert.match(chat.query, new RegExp(`^Changes requested on stage:deliver \\(“[^”]+”\\) of ask ${state.ask.id}: Add a review stage before delivery`));
  assert.match(chat.query, /update plan\.md, run `lifecycle\.py plan-sync`[\s\S]*lifecycle\.py stage deliver done/);
  assert.ok(chat.attachFiles.some(file => file.fsPath.endsWith('request.md')));
  const plan = text(dashboard(fixture.controls.commands.get('frontierHve.missionControlModel')(), { page: 'plan', filter: 'all', open: {}, seq: 0 }, Date.now()));
  assert.match(plan, /Your refinement went to the agent in Chat; accept once it is done again\./);
  assert.match(plan, /Refinement requested/);
  assert.match(plan, /docs\/policy\.md/);
  assert.match(plan, /decision ?active: Changes requested: Add a review stage before delivery[\s\S]*decision ?done: Built docs\/policy\.md/);
});

test('accepting unfinished work is refused before any confirmation or write', async t => {
  const fixture = mission(t);
  const state = await create(fixture, 'unfinished');
  const seen = fixture.controls.calls.length;
  await assert.rejects(fixture.controls.provider.execute({ action: 'review', item: 'stage:deliver', value: 'accepted', revision: state.reviews[0].revision }),
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
  await fixture.controls.provider.execute({ action: 'markDone', item: 'stage:deliver', revision: state.reviews[0].revision });
  const done = snapshot(fixture.root);
  assert.equal(done.reviews[0].status, 'done');
  assert.equal(done.decisions.at(-1).why, 'Checker built and verified in the chat.');
  fixture.controls.inputs.push('Ran the checker on two policies.');
  fixture.controls.confirmations.push('Accept');
  await fixture.controls.provider.execute({ action: 'review', item: 'stage:deliver', value: 'accepted', revision: done.reviews[0].revision });
  assert.equal(snapshot(fixture.root).reviews[0].decision, 'accepted');
  await assert.rejects(fixture.controls.provider.execute({ action: 'markDone', item: 'stage:deliver', revision: snapshot(fixture.root).reviews[0].revision }),
    /Only a planned or active stage/);
  fs.appendFileSync(path.join(fixture.root, '.aria', 'project', 'journal.jsonl'), JSON.stringify({ ts: '2026-11-06T10:00:00+00:00', ask: state.ask.id,
    stage: 'deliver', kind: 'pitfall', text: 'The policy files use Windows line endings', why: 'the parser split on \\n only' }) + '\n');
  assert.deepEqual(snapshot(fixture.root).journal.map(row => [row.kind, row.text]), [['pitfall', 'The policy files use Windows line endings']]);
});

test('Add a skill lists only library skills the ask lacks, adds the picked one after a confirmation, and a cancel changes nothing', async t => {
  const fixture = mission(t);
  const state = await create(fixture, 'skills');
  const before = state.skills.map(skill => skill.name);
  fixture.controls.picks.push(null);
  await fixture.controls.provider.execute({ action: 'addSkill', ask: state.ask.id });
  assert.equal(snapshot(fixture.root).revision, state.revision, 'cancelling the pick writes nothing');
  const offered = fixture.controls.calls.filter(call => call[0] === 'pick').at(-1)[1];
  assert.ok(offered.length && !offered.some(row => before.includes(row.label)), 'only skills the ask does not have are offered');
  fixture.controls.picks.push(0);
  fixture.controls.confirmations.push('Add skill');
  await fixture.controls.provider.execute({ action: 'addSkill', ask: state.ask.id });
  const added = snapshot(fixture.root);
  assert.deepEqual(added.skills.map(skill => skill.name), [...before, offered[0].label]);
  assert.equal(added.skills.at(-1).reason, 'added');
  assert.match(fixture.controls.calls.filter(call => call[0] === 'confirmation').at(-1)[2].detail, /Agents load it from the next message you send/);
  await assert.rejects(fixture.controls.provider.execute({ action: 'addSkill', ask: '20200101-0000-other' }), /active ask changed/);
});

test('a stale view cannot record a review after the project changes', async t => {
  const fixture = mission(t);
  const state = await create(fixture, 'stale');
  fs.appendFileSync(path.join(fixture.root, '.aria', 'asks', state.ask.id, 'plan.md'), '\nAnother requirement.');
  await assert.rejects(fixture.controls.provider.execute({ action: 'review', item: 'stage:deliver', value: 'changes', revision: state.reviews[0].revision }),
    /changed since you acted on it/);
  assert.equal(snapshot(fixture.root).reviews[0].decision, 'open');
});
