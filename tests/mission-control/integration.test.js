'use strict';
/** Exercise real task creation and guarded review persistence against the bundled lifecycle runtime. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { bundled, workspace, removeWorkspace } = require('./helpers');
const { lifecycle } = require('../../extension/ui/lifecycle-cli');
const { Workflow } = require('../../extension/ui/workflow');
const { snapshot } = require('../../extension/ui/workspace-state');

/** Prepare a scratch project using real lifecycle commands.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{root: string, storage: string, flow: Workflow, state: import('../../extension/ui/types').Snapshot}>}
 */
async function setup(t) {
  const root = workspace();
  const storage = workspace();
  t.after(() => { removeWorkspace(root); removeWorkspace(storage); });
  const flow = new Workflow(bundled(), storage);
  const description = await flow.describeAsk(root, 'Build an onboarding policy checker');
  assert.equal(description.verdict, 'new-project');
  assert.deepEqual(fs.readdirSync(root), []);
  const state = await flow.createAsk(root, description.activeAsk, 'policy', 'Build an onboarding policy checker');
  return { root, storage, flow, state };
}

/** Synchronize a real plan and finish its direct delivery stage.
 * @param {string} root
 * @param {string} ask
 * @returns {void}
 */
function completeStage(root, ask) {
  const connection = bundled();
  const plan = path.join(root, '.aria', 'asks', ask, 'plan.md');
  fs.writeFileSync(plan, '# Policy delivery\n\nCheck required configuration and report the result.\n' + fs.readFileSync(plan, 'utf8'));
  for (const args of [['plan-sync', 'Recorded test plan'], ['stage', 'deliver', 'done', 'Verified scratch delivery']]) {
    execFileSync(connection.python, ['-B', connection.script, ...args], { cwd: root, env: { ...process.env, PYTHONUTF8: '1' } });
  }
}

test('real task creation is visible to the harness and cleans request inputs', async t => {
  const { root, storage, state } = await setup(t);
  assert.match(state.ask.id, /-policy$/);
  assert.equal(state.ask.agent, 'ARIA Lite');
  const where = await lifecycle(bundled(), root, ['where']);
  assert.equal(where.open_ask.ask, state.ask.id);
  assert.equal(where.project.asks[0], state.ask.id);
  assert.deepEqual(fs.readdirSync(storage), []);
  assert.ok(fs.existsSync(path.join(root, '.aria', 'asks', state.ask.id, 'request.md')));
});

test('acceptance and requested changes persist through the guarded API', async t => {
  const { root, flow, state } = await setup(t);
  completeStage(root, state.ask.id);
  const ready = snapshot(root);
  const ticket = flow.prepareReview(root, ready.reviews[0].revision, 'stage:deliver', 'accepted');
  const accepted = await flow.recordReview(root, ticket, 'Human inspected the scratch evidence');
  assert.equal(accepted.reviews[0].decision, 'accepted');
  assert.equal(accepted.decisions.at(-1).choice, 'accepted');
  const next = flow.prepareReview(root, accepted.reviews[0].revision, 'stage:deliver', 'changes');
  const revised = await flow.recordReview(root, next, 'Add a missing input check');
  assert.equal(revised.reviews[0].decision, 'changes');
  assert.equal(revised.reviews[0].note, 'Add a missing input check');
});

test('a decision records while the agent keeps writing evidence, attempts and loop state elsewhere in the workspace', async t => {
  const { root, flow, state } = await setup(t);
  completeStage(root, state.ask.id);
  const seen = snapshot(root).reviews[0].revision;
  const ticket = flow.prepareReview(root, seen, 'stage:deliver', 'changes');
  const loop = path.join(root, '.aria', 'asks', state.ask.id, 'loop');
  fs.mkdirSync(path.join(loop, 'evidence', 'hello-page'), { recursive: true });
  fs.writeFileSync(path.join(loop, 'evidence', 'hello-page', 'dark.png'), 'png');
  fs.mkdirSync(path.join(loop, 'attempts'), { recursive: true });
  fs.writeFileSync(path.join(loop, 'attempts', 'hello-page.jsonl'), '{}\n');
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>Hello</h1>');
  assert.notEqual(snapshot(root).revision, ticket.itemRevision, 'the workspace moved on while the user typed the note');
  const revised = await flow.recordReview(root, ticket, 'Use the brand colours in dark mode');
  assert.deepEqual([revised.reviews[0].decision, revised.reviews[0].note], ['changes', 'Use the brand colours in dark mode']);
});

test('preparing a review ticket does not write project state', async t => {
  const { root, flow, state } = await setup(t);
  completeStage(root, state.ask.id);
  const ready = snapshot(root);
  const contract = fs.readFileSync(path.join(root, '.aria', 'asks', state.ask.id, 'contract.json'));
  flow.prepareReview(root, ready.reviews[0].revision, 'stage:deliver', 'accepted');
  assert.equal(snapshot(root).revision, ready.revision);
  assert.deepEqual(fs.readFileSync(path.join(root, '.aria', 'asks', state.ask.id, 'contract.json')), contract);
});

test('stale UI and active-ask switches cannot approve another task', async t => {
  const { root, flow, state } = await setup(t);
  completeStage(root, state.ask.id);
  const ready = snapshot(root);
  const ticket = flow.prepareReview(root, ready.reviews[0].revision, 'stage:deliver', 'accepted');
  const core = await lifecycle(bundled(), root, ['review-status', state.ask.id]);
  const second = await flow.createAsk(root, state.ask.id, 'second', 'Build a second onboarding checker');
  await assert.rejects(flow.recordReview(root, ticket, 'Old approval'), /changed since you acted on it/);
  await assert.rejects(lifecycle(bundled(), root, ['tick-for', ticket.ask, core.revision, ticket.item, ticket.value, 'Stale subprocess']), /changed/);
  assert.ok(second.reviews.every(review => review.decision === 'open'));
  assert.ok(snapshot(root).reviews.every(review => review.decision === 'open'));
});

test('changed plans, incomplete work, and invalid identifiers reject before mutation', async t => {
  const { root, flow, state } = await setup(t);
  await assert.rejects(async () => flow.prepareReview(root, state.reviews[0].revision, 'stage:deliver', 'accepted'), /Acceptance requires/);
  await assert.rejects(flow.createAsk(root, state.ask.id, '..\\escape', 'Build a checker'), /Ask name must contain/);
  completeStage(root, state.ask.id);
  const ready = snapshot(root);
  const ticket = flow.prepareReview(root, ready.reviews[0].revision, 'stage:deliver', 'accepted');
  fs.appendFileSync(path.join(root, '.aria', 'asks', state.ask.id, 'plan.md'), '\nAnother requirement.');
  await assert.rejects(flow.recordReview(root, ticket, 'Old approval'), /changed since you acted on it/);
  assert.equal(snapshot(root).reviews[0].decision, 'open');
  assert.equal(flow.busy, false);
});
