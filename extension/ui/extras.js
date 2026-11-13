'use strict';
/** Mission Control extras: prune and repoint research telemetry, built-in example pack and checklist wiki, solution map and infographic chat. */
const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { buildMap } = require('./lifecycle-cli');
const { containedPath } = require('./file-access');
const { AGENT } = require('./ask-flow');
const { record, text, list } = require('./validate');
const { renderPacks } = require('../render');
const { BRAND, DEFAULT_ARIA, cmd } = require('../brand');
const STATE = BRAND.state_dir;
const MAP_PAGE = path.join(STATE, 'map', 'explorer.html');
const EXAMPLE_PACK_REL = path.join('runtime', 'examples', 'plugins', 'oracle-offering');
const PACK_CHECKLIST_REL = path.join('runtime', 'docs', 'wiki', 'Pack-Checklist.md');
const execute = promisify(execFile);

/** @typedef {import('./mission-control').MissionControl} MissionControl */

/** Return existing .jsonl telemetry files across the configured export and the workspace's own .aria/runs/copilot-otel.jsonl.
 * @param {MissionControl} mc
 * @returns {string[]}
 */
function telemetryTargets(mc) {
  const otel = vscode.workspace.getConfiguration('github.copilot.chat.otel');
  const raw = otel.get('outfile');
  const ws = mc.workspace?.uri.scheme === 'file' ? mc.workspace.uri.fsPath : null;
  const configured = typeof raw === 'string' && raw ? (path.isAbsolute(raw) || !ws ? raw : path.join(ws, raw)) : null;
  if (configured && !configured.endsWith('.jsonl')) throw new Error(`Mission Control only prunes a .jsonl telemetry export, not ${configured}.`);
  const local = ws ? path.join(ws, STATE, 'runs', 'copilot-otel.jsonl') : null;
  const norm = (/** @type {string} */ value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const files = [...new Map([configured, local].filter(/** @returns {f is string} */ f => Boolean(f && f.endsWith('.jsonl') && fs.existsSync(f) && fs.statSync(f).isFile()))
    .map(f => [norm(f), f])).values()];
  if (!files.length) {
    if (!configured) throw new Error('No telemetry export is configured. Turn research telemetry on once to create it.');
    throw new Error(`There is no telemetry export to prune at ${configured}.`);
  }
  return files;
}

/** Archive and empty, or just empty, the research telemetry export(s) after the user confirms.
 * @param {MissionControl} mc
 * @returns {Promise<void>}
 */
async function pruneTelemetry(mc) {
  const files = telemetryTargets(mc);
  const totalBytes = files.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  const megabytes = (totalBytes / 1024 / 1024).toFixed(1);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const choice = await vscode.window.showWarningMessage(`Prune research telemetry (${megabytes} MB)?`, { modal: true, detail: `${files.join('\n')}\n\n`
    + `Archive, then empty: a compressed copy goes to otel-archive-${stamp}.jsonl.gz next to each export, then the export is emptied.\n`
    + 'Delete all records: the export is emptied with no copy.\n\n'
    + `Research telemetry stays ${mc.telemetry().enabled ? 'on: new chats keep recording' : 'off'}. Token figures for chats recorded before now are lost from the Telemetry tab. `
    + 'Best done while no chat is running.' }, 'Archive, then empty', 'Delete all records');
  if (!choice) return;
  /** @type {string[]} */
  const archives = [];
  for (const file of files) {
    if (choice === 'Archive, then empty' && fs.statSync(file).size > 0) {
      const archive = path.join(path.dirname(file), `otel-archive-${stamp}.jsonl.gz`);
      await pipeline(fs.createReadStream(file), zlib.createGzip(), fs.createWriteStream(archive));
      if (!fs.statSync(archive).size) throw new Error(`The archive ${archive} is empty; the export was not emptied.`);
      archives.push(archive);
    }
    fs.truncateSync(file, 0);
  }
  void vscode.window.showInformationMessage(choice === 'Archive, then empty'
    ? `Telemetry archived to ${archives.join(', ') || 'archive'} and the export emptied.` : 'Telemetry export emptied.');
}

/** Point Copilot's global OTel file export at the currently followed workspace folder, creating .aria/runs/copilot-otel.jsonl if needed.
 * @param {MissionControl} mc
 * @returns {Promise<void>}
 */
async function repointTelemetry(mc) {
  const root = mc.target().uri.fsPath;
  const target = path.join(root, STATE, 'runs', 'copilot-otel.jsonl');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) fs.writeFileSync(target, '');
  const otel = vscode.workspace.getConfiguration('github.copilot.chat.otel');
  await otel.update('enabled', true, vscode.ConfigurationTarget.Global);
  await otel.update('exporterType', 'file', vscode.ConfigurationTarget.Global);
  await otel.update('outfile', target, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(`Research telemetry now writes to ${target}.`);
}

/** Return metadata for the bundled Oracle Offering example expertise pack when present in runtime/.
 * @param {string} extensionPath
 * @returns {import('./types').ExamplePack | null}
 */
function examplePack(extensionPath) {
  const folder = path.join(extensionPath, EXAMPLE_PACK_REL);
  const manifestFile = path.join(folder, 'hve-plugin.json');
  const registryFile = path.join(folder, 'registry.json');
  if (!fs.existsSync(manifestFile) || !fs.existsSync(registryFile)) return null;
  const data = record(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), 'Example pack manifest');
  const reg = record(JSON.parse(fs.readFileSync(registryFile, 'utf8')), 'Example pack registry');
  const routing = record(data.routing, 'Example pack routing');
  return {
    id: `${text(data.publisher, 'Publisher')}.${text(data.name, 'Name')}`,
    name: text(data.name, 'Name'),
    displayName: text(data.displayName, 'Display name'),
    version: text(data.version, 'Version'),
    description: text(data.description, 'Description'),
    agents: list(data.agents, 'Agents').map(a => text(record(a, 'Agent').name, 'Agent name')),
    lifecycles: list(data.lifecycles || [], 'Lifecycles').map(l => path.basename(text(l, 'Lifecycle'), '.json')),
    skills: list(reg.skills, 'Skills').map(s => text(record(s, 'Skill').name, 'Skill name')),
    templates: Object.keys(record(data.templates, 'Templates')),
    knowledge: list(data.knowledge || [], 'Knowledge').map(k => text(record(k, 'Knowledge item').id, 'Knowledge id')),
    domains: list(routing.domains, 'Domains').map(d => text(d, 'Domain')),
  };
}

/** Open the bundled Expertise Pack Checklist wiki page beside Mission Control.
 * @param {MissionControl} mc
 * @returns {Promise<void>}
 */
async function openPackChecklist(mc) {
  const wiki = path.join(mc.context.extensionPath, PACK_CHECKLIST_REL);
  if (!fs.existsSync(wiki)) throw new Error(`Pack checklist wiki is missing at ${wiki}.`);
  const uri = vscode.Uri.file(wiki);
  await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
}

/** Install the bundled Oracle Offering example pack into the user's pack store after hash confirmation, render its agents, and refresh.
 * @param {MissionControl} mc
 * @returns {Promise<void>}
 */
async function installExamplePack(mc) {
  const folder = path.join(mc.context.extensionPath, EXAMPLE_PACK_REL);
  if (!fs.existsSync(path.join(folder, 'hve-plugin.json'))) throw new Error(`Built-in example pack is missing at ${folder}.`);
  const flow = await mc.connect();
  const conn = flow.connection;
  const script = path.join(conn.extensionPath, 'runtime', 'tools', 'plugins', 'plugin.py');
  const cwd = mc.workspace?.uri.scheme === 'file' ? mc.workspace.uri.fsPath : conn.extensionPath;
  /** @param {string[]} args @returns {Promise<Record<string, unknown>>} */
  const runPlugin = async args => {
    const out = await execute(conn.python, [...conn.pythonArguments, '-B', script, ...args], {
      cwd, timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
    });
    return record(JSON.parse(out.stdout), `plugin.py ${args[0]}`);
  };
  const info = await runPlugin(['inspect', folder]);
  const sha = text(info.sha256, 'Pack sha256');
  const tools = list(info.tools, 'Pack tools').map(t => text(t, 'Tool')).join(', ');
  if (info.needsConfirmation === true) {
    const detail = `${text(info.id, 'Id')} ${text(info.version, 'Version')} by ${text(info.publisher, 'Publisher')}\nsha256 ${sha}\n`
      + `Built-in example pack shipped with ${BRAND.product}.\nTools its agents may use: ${tools}`;
    const choice = await vscode.window.showWarningMessage(`Install built-in example pack ${text(info.name, 'Name')}?`, { modal: true, detail }, 'Install');
    if (choice !== 'Install') return;
  }
  await runPlugin(['install', folder, '--confirm', sha, '--owner', 'user']);
  const home = process.env[`${BRAND.prefix.toUpperCase()}_PLUGIN_HOME`] || process.env.HVE_PLUGIN_HOME
    || path.join(os.homedir(), DEFAULT_ARIA ? '.frontier-hve' : `.${BRAND.prefix}-packs`);
  const allOut = await execute(conn.python, [...conn.pythonArguments, '-B', script, 'packs', cwd], {
    cwd, timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
  });
  const renderedRoot = path.join(home, 'rendered');
  const rendered = renderPacks(conn.extensionPath, [conn.python, ...conn.pythonArguments].join(' '), renderedRoot, JSON.parse(allOut.stdout));
  const chat = vscode.workspace.getConfiguration('chat');
  const current = /** @type {Record<string, boolean>} */ (chat.get('pluginLocations') || {});
  const kept = Object.fromEntries(Object.entries(current).filter(([dir]) => !dir.startsWith(renderedRoot + path.sep)));
  await chat.update('pluginLocations', { ...kept, ...Object.fromEntries(rendered.map(dir => [dir, true])) }, vscode.ConfigurationTarget.Global);
  await mc.loadPacks();
  void vscode.window.showInformationMessage(`Installed built-in example pack ${text(info.name, 'Name')} ${text(info.version, 'Version')}. Reload the window to list its agents in Chat.`);
}

/** Return when the solution map page was last built, or null.
 * @param {string} root
 * @returns {{built: string, bytes: number} | null}
 */
function mapInfo(root) {
  const page = containedPath(root, MAP_PAGE);
  if (!fs.existsSync(page)) return null;
  const stat = fs.statSync(page);
  return { built: stat.mtime.toISOString(), bytes: stat.size };
}

/** Build or refresh the workspace's solution map with the bundled tool, then open it in a tab.
 * @param {MissionControl} mc
 * @returns {Promise<void>}
 */
async function refreshMap(mc) {
  const root = mc.target().uri.fsPath;
  const flow = await mc.connect();
  const map = await buildMap(flow.connection, root);
  void vscode.window.showInformationMessage(`Solution map built: ${map.sizeClass} repository, ${map.files} files, ${map.concepts} concepts.`);
  openMap(mc);
}

/** Show the solution map explorer in its own editor tab; it is the self-contained page the map tool writes.
 * @param {MissionControl} mc
 * @returns {void}
 */
function openMap(mc) {
  const page = containedPath(mc.target().uri.fsPath, MAP_PAGE);
  if (!fs.existsSync(page)) throw new Error('There is no solution map yet. Build it first.');
  const html = fs.readFileSync(page, 'utf8');
  if (mc.mapPanel) mc.mapPanel.reveal(vscode.ViewColumn.Active);
  else {
    const panel = vscode.window.createWebviewPanel(cmd('solutionMap'), 'Solution map', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
    panel.onDidDispose(() => { mc.mapPanel = null; });
    mc.mapPanel = panel;
  }
  /** @type {vscode.WebviewPanel} */ (mc.mapPanel).webview.html = html;
}

/** Open a new Local chat with the clickable-infographic skill and a subject filled in, not sent.
 * @param {MissionControl} mc
 * @returns {Promise<void>}
 */
async function infographic(mc) {
  mc.target();
  const subject = await vscode.window.showInputBox({ title: 'Clickable infographic: what should it show?', value: 'How this repository works, from request to delivery',
    prompt: 'A subject and the question it answers. A chat opens with the infographic skill and this filled in; you send it.', ignoreFocusOut: true,
    validateInput: value => value.trim().length < 3 || value.length > 300 ? 'Use 3-300 characters.' : null });
  if (subject === undefined) return;
  await vscode.commands.executeCommand('workbench.action.chat.open');
  await vscode.commands.executeCommand('workbench.action.chat.newLocalChat');
  await vscode.commands.executeCommand('workbench.action.chat.open', { query: `/clickable-infographic ${subject.trim()}`, isPartialQuery: true, mode: AGENT });
}

module.exports = { pruneTelemetry, repointTelemetry, examplePack, openPackChecklist, installExamplePack, mapInfo, refreshMap, openMap, infographic };
