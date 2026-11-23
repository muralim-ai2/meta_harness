'use strict';
/** Verify Mission Control ships inside the existing extension, activates without a Copilot dependency, and owns only its resources. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EXTENSION, workspace, removeWorkspace } = require('./helpers');
const { host, mission } = require('./vscode-stub');
const { project } = require('./fixtures');
const { snapshot, planDigest } = require('../../extension/ui/workspace-state');
const { message } = require('../../extension/ui/validate');
const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION, 'package.json'), 'utf8'));
const ORIGINAL = ['frontierHve.setup', 'frontierHve.installHarnesses', 'frontierHve.researchTelemetry', 'frontierHve.researchTelemetryOff',
  'frontierHve.installPlugin', 'frontierHve.managePlugins'];
const MISSION = ['frontierHve.openMissionControl', 'frontierHve.refreshMissionControl', 'frontierHve.selectWorkspace', 'frontierHve.newAsk',
  'frontierHve.editPlan'];

/** Return the models posted to views so far.
 * @param {{calls: unknown[][]}} controls
 * @returns {import('../../extension/ui/types').Model[]}
 */
function posted(controls) {
  return controls.calls.filter(call => call[0] === 'post').map(call => /** @type {{model: import('../../extension/ui/types').Model}} */ (call[1]).model);
}

test('the existing extension contributes Mission Control, keeps its commands and has no Copilot extension dependency', () => {
  assert.equal(manifest.name, 'frontier-hve');
  assert.equal(manifest.displayName, 'Frontier-HVE');
  assert.ok(fs.statSync(path.join(EXTENSION, manifest.icon)).isFile(), manifest.icon);
  assert.equal(manifest.extensionDependencies, undefined);
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(manifest.activationEvents, ['onStartupFinished']);
  assert.deepEqual(manifest.contributes.commands.map(command => command.command), [...ORIGINAL, ...MISSION]);
  assert.deepEqual(manifest.contributes.viewsContainers.activitybar, [{ id: 'frontierHve', title: 'Frontier-HVE', icon: 'ui/media/hve.svg' }]);
  assert.deepEqual(manifest.contributes.views.frontierHve, [{ type: 'webview', id: 'frontierHve.missionControl', name: 'Mission Control' },
    { id: 'frontierHve.harnessFiles', name: 'Harness files' }]);
  assert.ok(manifest.contributes.configuration.properties['frontierHve.pluginIndex']);
  for (const file of ['hve.svg', 'aria.png', 'app.css', 'app.js', 'vnode.js', 'markdown.js', 'views.js', 'pages.js']) {
    assert.ok(fs.statSync(path.join(EXTENSION, 'ui', 'media', file)).isFile(), file);
  }
});

test('full activation registers Mission Control before setup work, keeps every original behaviour and shows state without Python', async t => {
  const root = workspace();
  const storage = workspace();
  const fixture = host([root], storage);
  const searchPath = process.env.PATH;
  process.env.PATH = '';
  t.after(() => {
    process.env.PATH = searchPath;
    fixture.context.subscriptions.forEach(resource => resource.dispose());
    [root, storage].forEach(removeWorkspace);
  });
  const activation = fixture.load('extension.js').activate(fixture.context);
  for (const id of [...ORIGINAL, ...MISSION]) assert.ok(fixture.controls.commands.has(id), id);
  assert.ok(fixture.controls.calls.some(call => call[0] === 'provider' && call[1] === 'frontierHve.missionControl'));
  await activation;
  assert.ok(fs.statSync(path.join(storage, 'plugin', 'plugin.json')).isFile());
  assert.deepEqual(fixture.controls.settings.get('chat.pluginLocations'), { [path.join(storage, 'plugin')]: true });
  assert.ok(fixture.controls.statusItems.some(item => item.visible && item.text.includes('guards off')));
  assert.equal((await fixture.controls.commands.get('frontierHve.refreshMissionControl')()).ask, null);
  assert.equal(fixture.controls.commands.get('frontierHve.missionControlModel')().connection.python, null);
  await assert.rejects(fixture.controls.commands.get('frontierHve.newAsk')(), /needs Python 3\.11\+/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('ARIA: Set up writes the workspace state to .aria and never creates .hve', async t => {
  const root = workspace();
  const storage = workspace();
  const fixture = host([root], storage);
  const searchPath = process.env.PATH;
  process.env.PATH = '';
  t.after(() => {
    process.env.PATH = searchPath;
    fixture.context.subscriptions.forEach(resource => resource.dispose());
    [root, storage].forEach(removeWorkspace);
  });
  await fixture.load('extension.js').activate(fixture.context);
  process.env.PATH = searchPath;
  await fixture.controls.commands.get('frontierHve.setup')();
  assert.deepEqual(fs.readdirSync(root).sort(), ['.aria', '.gitignore']);
  for (const entry of ['runs', 'user_profile.json', 'context_load.json']) assert.ok(fs.existsSync(path.join(root, '.aria', entry)), entry);
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.aria\/$/m);
});

/** Write a workspace file, creating its folders.
 * @param {string} root
 * @param {string} relative
 * @param {string} content
 */
function put(root, relative, content) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content);
}

/** Activate the extension without Python on a workspace and return the host double.
 * @param {import('node:test').TestContext} t
 * @param {string} root
 * @returns {Promise<ReturnType<typeof host>>}
 */
async function activateOn(t, root) {
  const storage = workspace();
  const fixture = host([root], storage);
  const searchPath = process.env.PATH;
  process.env.PATH = '';
  t.after(() => {
    process.env.PATH = searchPath;
    fixture.context.subscriptions.forEach(resource => resource.dispose());
    [root, storage].forEach(removeWorkspace);
  });
  fixture.controls.settings.set('github.copilot.chat.otel.outfile', path.join(root, '.hve', 'runs', 'copilot-otel.jsonl'));
  await fixture.load('extension.js').activate(fixture.context);
  return fixture;
}

test('activation moves a pre-0.24 .hve into .aria, rewrites stored ask paths, keeps the plan digest valid and keeps git ignoring it', async t => {
  const root = workspace();
  const ask = '20261101-1200-demo';
  const plan = `# Plan\n\nRecords live in .hve/asks/${ask}/loop.\n<!-- hve:skills -->\n- .hve/skills/prd/SKILL.md\n<!-- /hve:skills -->\n`;
  put(root, `.hve/asks/${ask}/plan.md`, plan);
  put(root, `.hve/asks/${ask}/contract.json`, JSON.stringify({ paths: { ask: `.hve/asks/${ask}`, plan: `.hve/asks/${ask}/plan.md` },
    plan: { sha256: planDigest(plan), revisions: [] } }, null, 2));
  put(root, '.hve/asks/active.json', JSON.stringify({ active: ask }));
  put(root, '.hve/project/project.json', JSON.stringify({ feature_list: '.hve/project/feature_list.json' }));
  put(root, '.hve/runs/s1.jsonl', '{}\n');
  put(root, '.aria/runs/s2.jsonl', '{}\n');
  put(root, '.gitignore', 'node_modules/\n.hve/\n.hve/runs/copilot-otel.jsonl');
  const fixture = await activateOn(t, root);
  assert.deepEqual(fixture.controls.errors, []);
  assert.ok(!fs.existsSync(path.join(root, '.hve')));
  assert.deepEqual(fs.readdirSync(path.join(root, '.aria', 'runs')).sort(), ['s1.jsonl', 's2.jsonl']);
  const contract = JSON.parse(fs.readFileSync(path.join(root, '.aria', 'asks', ask, 'contract.json'), 'utf8'));
  assert.deepEqual(contract.paths, { ask: `.aria/asks/${ask}`, plan: `.aria/asks/${ask}/plan.md` });
  const moved = fs.readFileSync(path.join(root, '.aria', 'asks', ask, 'plan.md'), 'utf8');
  assert.ok(!moved.includes('.hve/'));
  assert.equal(contract.plan.sha256, planDigest(moved));
  assert.match(fs.readFileSync(path.join(root, '.aria', 'project', 'project.json'), 'utf8'), /\.aria\/project\/feature_list\.json/);
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'),
    'node_modules/\n.hve/\n.hve/runs/copilot-otel.jsonl\n.aria/\n.aria/runs/copilot-otel.jsonl\n');
  assert.equal(fixture.controls.settings.get('github.copilot.chat.otel.outfile'), path.join(root, '.aria', 'runs', 'copilot-otel.jsonl'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.aria', 'asks', 'active.json'), 'utf8')), { active: ask });
});

test('activation leaves a file that exists in both .hve and .aria in .hve and names it in an error', async t => {
  const root = workspace();
  put(root, '.hve/user_profile.json', '{"old": true}');
  put(root, '.hve/context_load.json', '{}');
  put(root, '.aria/user_profile.json', '{"new": true}');
  const fixture = await activateOn(t, root);
  assert.equal(fixture.controls.errors.length, 1);
  assert.match(fixture.controls.errors[0], /1 file\(s\) that exist in both, for example \.hve[\\/]user_profile\.json/);
  assert.deepEqual(fs.readdirSync(path.join(root, '.hve')), ['user_profile.json']);
  assert.equal(fs.readFileSync(path.join(root, '.aria', 'user_profile.json'), 'utf8'), '{"new": true}');
  assert.ok(fs.existsSync(path.join(root, '.aria', 'context_load.json')));
});

test('with the old muralim-ai2 ARIA still installed, activation registers nothing and offers to uninstall it', async t => {
  const root = workspace();
  const storage = workspace();
  const fixture = host([root], storage);
  t.after(() => [root, storage].forEach(removeWorkspace));
  fixture.controls.extensions.push('muralim-ai2.frontier-hve');
  fixture.controls.confirmations.push('Uninstall old version');
  await fixture.load('extension.js').activate(fixture.context);
  assert.equal(fixture.controls.commands.size, 0);
  assert.ok(fixture.controls.calls.some(call => call[0] === 'workbench.extensions.uninstallExtension' && call[1] === 'muralim-ai2.frontier-hve'));
});

test('registering the agents drops the old muralim-ai2 plugin folder and keeps other plugin locations', async t => {
  const root = workspace();
  const storage = workspace();
  const fixture = host([root], storage);
  const searchPath = process.env.PATH;
  process.env.PATH = '';
  t.after(() => {
    process.env.PATH = searchPath;
    fixture.context.subscriptions.forEach(resource => resource.dispose());
    [root, storage].forEach(removeWorkspace);
  });
  const legacy = path.join(path.dirname(storage), 'muralim-ai2.frontier-hve', 'plugin');
  fixture.controls.settings.set('chat.pluginLocations', { [legacy]: true, '/other/plugin': true });
  await fixture.load('extension.js').activate(fixture.context);
  assert.deepEqual(fixture.controls.settings.get('chat.pluginLocations'), { '/other/plugin': true, [path.join(storage, 'plugin')]: true });
});

test('registration is passive, watches harness state and chat transcripts, and posts the model without creating project files', async t => {
  const fixture = mission(t);
  assert.ok(!fixture.controls.calls.some(call => call[0] !== 'provider'));
  assert.deepEqual(fixture.controls.watchers.map(watcher => watcher.pattern.pattern), ['.aria/**/*', 'GitHub.copilot-chat/transcripts/*.jsonl', '.harness/**/*']);
  assert.equal(fixture.controls.watchers[1].pattern.base.fsPath, path.join(fixture.storage, 'window'));
  const view = fixture.controls.view();
  fixture.controls.provider.resolveWebviewView(view);
  assert.ok(view.webview.options.localResourceRoots[0].fsPath.endsWith(path.join('extension', 'ui', 'media')));
  for (const script of ['vnode.js', 'markdown.js', 'views.js', 'pages.js', 'app.js']) assert.match(view.webview.html, new RegExp(script.replace('.', '\\.')));
  const result = await fixture.controls.commands.get('frontierHve.refreshMissionControl')();
  assert.equal(result.ask, null);
  assert.deepEqual(fs.readdirSync(fixture.root), []);
  const model = posted(fixture.controls).at(-1);
  assert.equal(model.surface, 'sidebar');
  assert.equal(model.connection.version, manifest.version);
  assert.deepEqual(model.activity.chats, []);
  assert.deepEqual(model.asks, []);
});

test('multi-root requires selection and untrusted workspaces are rejected', async t => {
  const fixture = mission(t, 2);
  assert.equal(await fixture.controls.commands.get('frontierHve.refreshMissionControl')(), null);
  fixture.api.workspace.isTrusted = false;
  await assert.rejects(fixture.controls.commands.get('frontierHve.newAsk')(), /Trust this workspace/);
  assert.ok(fixture.controls.errors.length);
  assert.deepEqual(fs.readdirSync(fixture.root), []);
});

test('view messages are an allowlist: no arbitrary commands, no Chat drafts, no unexpected fields', () => {
  assert.throws(() => message({ action: 'execute', command: 'arbitrary' }), /Unknown UI/);
  assert.throws(() => message({ action: 'continue' }), /Unknown UI/);
  assert.throws(() => message({ action: 'refresh', shell: 'arbitrary' }), /Unexpected fields/);
  assert.throws(() => message({ action: 'review', item: 'stage:deliver' }), /Unexpected fields/);
  assert.equal(message({ action: 'openDashboard', page: 'plan' }).page, 'plan');
  assert.equal(message({ action: 'telemetry', value: 'on' }).value, 'on');
});

test('background changes refresh only a visible Mission Control, so hidden views never run the harness or raise errors', async t => {
  const fixture = mission(t);
  const changed = () => fixture.controls.watchers.forEach(watcher => watcher.listeners.forEach(listener => listener()));
  const settle = () => new Promise(resolve => setTimeout(resolve, 600));
  changed();
  await settle();
  assert.equal(posted(fixture.controls).length, 0);
  const view = fixture.controls.view(true);
  fixture.controls.provider.resolveWebviewView(view);
  changed();
  await settle();
  assert.equal(posted(fixture.controls).length, 1);
  view.visible = false;
  changed();
  await settle();
  assert.equal(posted(fixture.controls).length, 1);
  assert.deepEqual(fixture.controls.errors, []);
});

test('disposal removes only Mission Control resources and leaves harness state intact', async t => {
  const fixture = mission(t);
  project(fixture.root);
  await fixture.controls.commands.get('frontierHve.refreshMissionControl')();
  const before = snapshot(fixture.root).revision;
  fixture.context.subscriptions.forEach(resource => resource.dispose());
  for (const id of MISSION) assert.ok(!fixture.controls.commands.has(id), id);
  assert.equal(fixture.controls.provider, null);
  assert.ok(fixture.controls.watchers.every(watcher => watcher.disposed));
  assert.equal(snapshot(fixture.root).revision, before);
});
