'use strict';
/** Verify the Files page: the ask on screen as a bounded folder tree whose files open beside Mission Control, and nothing behind a link or outside the ask. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { workspace, removeWorkspace } = require('./helpers');
const { mission } = require('./vscode-stub');
const { project, realAsks, ASK } = require('./fixtures');
const { askTree } = require('../../extension/ui/asks');
const { text } = require('../../extension/ui/media/vnode');
const { sidebar } = require('../../extension/ui/media/views');
const { dashboard } = require('../../extension/ui/media/pages');
const FOLDER = `.aria/asks/${ASK}`;
const UI = { page: 'files', filter: 'all', open: {}, seq: 0 };

/** Return every view node matching a test.
 * @param {import('../../extension/ui/types').VNode | string} node
 * @param {(node: import('../../extension/ui/types').VNode) => boolean} match
 * @returns {import('../../extension/ui/types').VNode[]}
 */
function find(node, match) {
  return typeof node === 'string' ? [] : [...(match(node) ? [node] : []), ...node.children.flatMap(child => find(child, match))];
}

/** Create a project workspace removed after the test.
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function setup(t) {
  const root = workspace();
  t.after(() => removeWorkspace(root));
  project(root);
  return root;
}

test('an ask folder is a tree with folders first, sizes, times and workspace-relative paths', t => {
  const root = setup(t);
  const tree = askTree(root, ASK);
  assert.equal(tree.path, FOLDER);
  assert.deepEqual(tree.entries.map(node => [node.name, node.kind]), [['loop', 'folder'], ['contract.json', 'file'], ['plan.md', 'file'], ['request.md', 'file']]);
  const loop = tree.entries[0];
  assert.deepEqual(loop.children.map(node => node.name), ['evidence', 'prs']);
  assert.equal(loop.size, 2);
  const log = loop.children[0].children[0].children[0];
  assert.equal(log.path, `${FOLDER}/loop/evidence/policy/check.log`);
  assert.equal(log.size, 'All required checks passed.'.length);
  assert.ok(!Number.isNaN(Date.parse(log.modified)));
  assert.equal(tree.count, 9);
  assert.equal(tree.truncated, false);
  assert.throws(() => askTree(root, '..\\escape'), /Invalid ask identifier/);
  assert.throws(() => askTree(root, '20261028-1200-missing'), /No ask folder/);
});

test('links inside an ask are listed but never followed, and large or deep folders are cut with a note', t => {
  const root = setup(t);
  const outside = workspace();
  t.after(() => removeWorkspace(outside));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'private');
  fs.symlinkSync(outside, path.join(root, FOLDER, 'loop', 'outside'), 'junction');
  let tree = askTree(root, ASK);
  const link = tree.entries[0].children.find(node => node.name === 'outside');
  assert.equal(link.kind, 'other');
  assert.deepEqual(link.children, []);
  const bulk = path.join(root, FOLDER, 'loop', 'evidence', 'bulk');
  fs.mkdirSync(bulk);
  for (let index = 0; index < 450; index += 1) fs.writeFileSync(path.join(bulk, `log-${String(index).padStart(3, '0')}.txt`), 'x');
  tree = askTree(root, ASK);
  assert.equal(tree.count, 400);
  assert.equal(tree.truncated, true);
  fs.rmSync(bulk, { recursive: true });
  fs.mkdirSync(path.join(root, FOLDER, 'a', 'b', 'c', 'd', 'e', 'f', 'g'), { recursive: true });
  tree = askTree(root, ASK);
  assert.equal(tree.truncated, true);
  assert.ok(tree.count < 30);
});

test('the Files page shows the tree with the top folders open, explains each harness file and offers Show in Explorer', async t => {
  const fixture = mission(t);
  project(fixture.root);
  await fixture.controls.commands.get('frontierHve.refreshMissionControl')();
  const model = fixture.controls.commands.get('frontierHve.missionControlModel')();
  assert.equal(model.files.ask, ASK);
  const page = dashboard(model, UI, Date.now());
  const shown = text(page);
  assert.match(shown, new RegExp(`${FOLDER}/`));
  assert.match(shown, /plan\.mdthe plan the agent works to · \d+ B · /);
  assert.match(shown, /request\.mdyour request as saved/);
  assert.match(shown, /loopfeature checks, evidence and PR notes · 2 items/);
  const folders = find(page, node => node.tag === 'details' && node.attrs['data-key']?.startsWith('dir:'));
  assert.deepEqual(folders.map(node => [node.attrs['data-key'], 'open' in node.attrs]),
    [[`dir:${FOLDER}/loop`, true], [`dir:${FOLDER}/loop/evidence`, false], [`dir:${FOLDER}/loop/evidence/policy`, false], [`dir:${FOLDER}/loop/prs`, false]]);
  const opened = dashboard(model, { ...UI, open: { [`dir:${FOLDER}/loop`]: false, [`dir:${FOLDER}/loop/prs`]: true } }, Date.now());
  assert.deepEqual(find(opened, node => node.tag === 'details' && 'open' in node.attrs).map(node => node.attrs['data-key']), [`dir:${FOLDER}/loop/prs`]);
  const files = find(page, node => node.attrs['data-action'] === 'openFile').map(node => node.attrs['data-path']);
  assert.ok(files.includes(`${FOLDER}/loop/prs/policy.json`) && files.includes(`${FOLDER}/plan.md`));
  assert.equal(find(page, node => node.attrs['data-action'] === 'revealAsk').length, 1);
  assert.ok(find(page, node => node.attrs['data-action'] === 'go' && node.attrs['data-page'] === 'files').length);
  assert.match(text(sidebar({ ...model, surface: 'sidebar' }, UI, Date.now())), /Files9/);
});

test('files in the ask open beside Mission Control; files behind a link or outside the ask do not', async t => {
  const fixture = mission(t);
  project(fixture.root);
  const outside = workspace();
  t.after(() => removeWorkspace(outside));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'private');
  fs.symlinkSync(outside, path.join(fixture.root, FOLDER, 'linked'), 'junction');
  fs.writeFileSync(path.join(fixture.root, 'secret.txt'), 'private');
  await fixture.controls.commands.get('frontierHve.refreshMissionControl')();
  await fixture.controls.provider.execute({ action: 'openFile', path: `${FOLDER}/loop/prs/policy.json` });
  const opened = fixture.controls.calls.filter(call => call[0] === 'document');
  assert.equal(path.relative(fs.realpathSync(fixture.root), opened[0][1].fsPath), path.join('.aria', 'asks', ASK, 'loop', 'prs', 'policy.json'));
  assert.equal(opened[0][2].viewColumn, -2);
  await assert.rejects(fixture.controls.provider.execute({ action: 'openFile', path: `${FOLDER}/linked/secret.txt` }), /not listed/);
  await assert.rejects(fixture.controls.provider.execute({ action: 'openFile', path: 'secret.txt' }), /not listed/);
  await assert.rejects(fixture.controls.provider.execute({ action: 'openFile', path: `${FOLDER}/loop` }), /not listed/);
  await fixture.controls.provider.execute({ action: 'revealAsk' });
  const reveal = fixture.controls.calls.find(call => call[0] === 'revealInExplorer');
  assert.equal(path.relative(fs.realpathSync(fixture.root), reveal[1].fsPath), path.join('.aria', 'asks', ASK));
});

test('files a waiting question or a guard alert names, and the evidence of each sign-off item, are links that open; other files are not', async t => {
  const fixture = mission(t);
  const folder = project(fixture.root);
  const root = fixture.root;
  for (const [name, body] of [['docs/prd.md', '# PRD'], ['notes/push.md', 'push'], ['secret.txt', 'private']]) {
    fs.mkdirSync(path.join(root, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  const contractPath = path.join(root, folder, 'contract.json');
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  contract.stages[0].evidence = [{ type: 'artifacts', paths: ['docs/prd.md', 'docs/*.md', 'docs/missing.md'] }];
  fs.writeFileSync(contractPath, JSON.stringify(contract));
  const now = new Date().toISOString();
  const question = { header: 'sign-off', question: 'Accept the PRD?', message: 'Open [the PRD](docs/prd.md), `missing.md` and [outside](../outside.md).' };
  fs.mkdirSync(fixture.transcripts, { recursive: true });
  fs.writeFileSync(path.join(fixture.transcripts, 'review.jsonl'), [{ type: 'user.message', timestamp: now, data: { content: 'Review the PRD' } },
    { type: 'tool.execution_start', timestamp: now, data: { toolCallId: 'q', toolName: 'vscode_askQuestions', arguments: { questions: [question] } } }]
    .map(row => JSON.stringify(row) + '\n').join(''));
  fs.mkdirSync(path.join(root, '.aria', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aria', 'runs', 'review.interventions.jsonl'), JSON.stringify({ ts_ms: Date.now(), session_id: 'review', hook: 'loop_guard',
    kind: 'push_confirm', detail: 'Push check: git push needs your confirmation because of [push.md](notes/push.md).' }) + '\n');
  await fixture.controls.commands.get('frontierHve.refreshMissionControl')();
  const model = fixture.controls.commands.get('frontierHve.missionControlModel')();
  assert.equal(model.activity.session.status, 'waiting');
  assert.deepEqual(model.activity.session.current.files, ['docs/prd.md']);
  assert.deepEqual(model.activity.session.events.find(event => event.kind === 'guard').files, ['notes/push.md']);
  const links = (/** @type {string} */ page) => find(dashboard(model, { ...UI, page }, Date.now()), node => node.attrs.class === 'file-link').map(node => node.attrs['data-path']);
  assert.deepEqual([...new Set(links('live'))].sort(), ['docs/prd.md', 'notes/push.md']);
  const review = links('plan');
  assert.ok(review.includes(path.normalize('docs/prd.md')) && review.includes(path.join(folder, 'loop', 'prs', 'policy.json'))
    && review.includes(path.join(folder, 'loop', 'evidence', 'policy', 'check.log')), review.join(', '));
  for (const file of ['docs/prd.md', 'notes/push.md']) await fixture.controls.provider.execute({ action: 'openFile', path: file });
  assert.equal(fixture.controls.calls.filter(call => call[0] === 'document').length, 2);
  await assert.rejects(fixture.controls.provider.execute({ action: 'openFile', path: 'secret.txt' }), /not listed/);
});

test('the Files page follows the ask chosen in the dropdown', async t => {
  const fixture = mission(t);
  const [first, second] = await realAsks(fixture.root, fixture.storage, [['onboarding', 'Build an onboarding policy checker'], ['reporting', 'Write the quarterly revenue report']]);
  await fixture.controls.commands.get('frontierHve.refreshMissionControl')();
  assert.equal(fixture.controls.commands.get('frontierHve.missionControlModel')().files.ask, second);
  await fixture.controls.provider.execute({ action: 'selectAsk', ask: first });
  const model = fixture.controls.commands.get('frontierHve.missionControlModel')();
  assert.equal(model.files.ask, first);
  assert.ok(model.files.entries.some(node => node.path === `.aria/asks/${first}/request.md`));
  await fixture.controls.provider.execute({ action: 'openFile', path: `.aria/asks/${first}/request.md` });
  assert.ok(fixture.controls.calls.some(call => call[0] === 'document' && call[1].fsPath.endsWith(path.join(first, 'request.md'))));
});
