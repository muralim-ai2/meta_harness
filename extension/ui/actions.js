'use strict';
/** Mission Control's user actions on asks, chats, sign-offs, files and harness commands; each change to the workspace is confirmed first. */
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { BASE_COMMANDS } = require('./lifecycle-cli');
const { snapshot } = require('./workspace-state');
const { sameAsk } = require('./workflow');
const { listAsks, askTree, projectTree, evaluationFiles } = require('./asks');
const { claimsFrom, chatSessionUri, isLocalChat } = require('./chats');
const { containedPath } = require('./file-access');
const askFlow = require('./ask-flow');
const { BRAND, cmd } = require('../brand');
const STATE = BRAND.state_dir;
const IMAGES = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

/** @typedef {import('./mission-control').MissionControl} MissionControl */

/** Return an ask of this project, or fail.
 * @param {string} root
 * @param {string} ask
 * @returns {import('./types').AskSummary}
 */
function askOf(root, ask) {
  const row = listAsks(root).find(item => item.id === ask);
  if (!row) throw new Error(`No ask ${ask} in this project.`);
  return row;
}

/** Show an ask in Mission Control without changing which ask is active.
 * @param {MissionControl} mc
 * @param {string} ask
 * @returns {Promise<void>}
 */
async function selectAsk(mc, ask) {
  await mc.view(askOf(mc.target().uri.fsPath, ask).active ? null : ask);
}

/** Confirm and make an earlier ask the active one through the harness.
 * @param {MissionControl} mc
 * @param {string} ask
 * @returns {Promise<void>}
 */
async function activateAsk(mc, ask) {
  const root = mc.target().uri.fsPath;
  const row = askOf(root, ask);
  if (row.active) return;
  const current = listAsks(root).find(item => item.active);
  const flow = await mc.connect();
  const confirm = await vscode.window.showWarningMessage(`Make "${row.title}" the active ask?`, { modal: true, detail: [ask,
    'Agents, hooks and guards in this workspace then work on it (the harness runs lifecycle.py open).',
    current ? `The open ask "${current.title}" stays on disk, unfinished items included. You can make it active again any time.` : ''].filter(Boolean).join('\n\n') }, 'Make active');
  if (confirm !== 'Make active') return;
  mc.target();
  await flow.openAsk(root, ask);
  await mc.view(null);
}

/** Show one of the listed chats.
 * @param {MissionControl} mc
 * @param {string} chat
 * @returns {void}
 */
function selectChat(mc, chat) {
  if (!mc.state.activity?.chats.some(row => row.id === chat)) throw new Error('That chat is not listed in Mission Control.');
  mc.chat = { id: chat, at: new Date().toISOString() };
}

/** Open one of the listed chats in Copilot Chat, for example to answer it or allow a step.
 * @param {MissionControl} mc
 * @param {string} chat
 * @returns {Promise<void>}
 */
async function openChat(mc, chat) {
  if (!mc.state.activity?.chats.some(row => row.id === chat)) throw new Error('That chat is not listed in Mission Control.');
  if (isLocalChat(mc.transcripts(), chat)) await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(chatSessionUri(chat)));
  else await vscode.commands.executeCommand('workbench.action.chat.open');
}

/** Link a listed chat to the ask on screen; the link lives in this window's Mission Control state only.
 * @param {MissionControl} mc
 * @param {string} chat
 * @returns {Promise<void>}
 */
async function linkChat(mc, chat) {
  const ask = mc.state.snapshot?.ask?.id;
  if (!ask) throw new Error('Choose an ask first.');
  selectChat(mc, chat);
  await mc.context.workspaceState.update('chatAsks', { ...claimsFrom(mc.context.workspaceState.get('chatAsks')), [chat]: { ask, how: 'linked' } });
}

/** Open the plan.md of the ask on screen in a text editor beside Mission Control.
 * @param {MissionControl} mc
 * @returns {Promise<void>}
 */
async function editPlan(mc) {
  const state = snapshot(mc.target().uri.fsPath, mc.selected);
  if (!state.plan) throw new Error('There is no plan.md to edit: create an ask first.');
  await vscode.window.showTextDocument(vscode.Uri.file(containedPath(state.workspace, state.plan.path)), { viewColumn: vscode.ViewColumn.Beside, preview: false });
}

/** Show the folder of the ask on screen in VS Code's Explorer.
 * @param {MissionControl} mc
 * @returns {Promise<void>}
 */
async function revealAsk(mc) {
  const state = snapshot(mc.target().uri.fsPath, mc.selected);
  if (!state.ask) throw new Error('There is no ask to show.');
  await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(containedPath(state.workspace, path.join(STATE, 'asks', state.ask.id))));
}

/** Return the chat message that hands a change request to the ask's agent.
 * @param {string} ask
 * @param {import('./types').Review} item
 * @param {string} note
 * @returns {string}
 */
function changeMessage(ask, item, note) {
  const stage = item.item.startsWith('stage:') ? item.item.slice('stage:'.length) : null;
  return [`Changes requested on ${item.item} (“${item.title}”) of ask ${ask}: ${note}`, '',
    'Make these changes in this ask. If they change the plan (for example a new stage), update plan.md, run `lifecycle.py plan-sync`, and log the decision.',
    stage ? `When they are done, set the stage done again with \`lifecycle.py stage ${stage} done "<what changed>"\` and link the files I should look at, so I can review it.`
      : 'When they are done, re-run its check and link the files I should look at, so I can review it.'].join('\n');
}

/** Confirm and record a human sign-off through the guarded review commands; a change request also goes to the ask's agent in Chat.
 * @param {MissionControl} mc
 * @param {Record<string, string>} data
 * @returns {Promise<void>}
 */
async function review(mc, data) {
  if (data.value !== 'accepted' && data.value !== 'changes') throw new Error('Unknown review decision.');
  const target = mc.target();
  const flow = await mc.connect();
  const ticket = flow.prepareReview(target.uri.fsPath, data.revision, data.item, data.value);
  const item = /** @type {import('./types').Review} */ (snapshot(target.uri.fsPath).reviews.find(row => row.item === data.item));
  const changes = data.value === 'changes';
  const note = await vscode.window.showInputBox({ title: changes ? `What should change in ${data.item}?` : `Accept ${data.item}: what did you check?`,
    placeHolder: changes ? 'For example: add a review stage before delivery' : undefined, ignoreFocusOut: true,
    validateInput: value => !value.trim() ? 'A note is required.' : value.length > 4000 ? 'Use at most 4,000 characters.' : null });
  if (note === undefined) return;
  const label = changes ? 'Request changes' : 'Accept';
  const confirm = await vscode.window.showWarningMessage(`${label}: ${data.item}?`, { modal: true,
    detail: `Ask ${ticket.ask} in ${target.uri.fsPath}\n\n“${note}”\n\n` + (changes
      ? `This records your request${item.status === 'done' ? ', sets the stage back to active' : ''} and opens the ask's chat with your request filled in `
        + 'for its agent, plan attached. Press Enter in Chat to send it; you can add detail first.'
      : 'This records your decision in the ask. It does not push code or start the next stage.') }, label);
  if (confirm !== label) return;
  mc.target();
  await flow.recordReview(target.uri.fsPath, ticket, note);
  if (!changes) {
    void vscode.window.showInformationMessage(`Accepted ${data.item}.`);
    return;
  }
  await askFlow.messageInChat(mc, ticket.ask, changeMessage(ticket.ask, item, note));
  void vscode.window.showInformationMessage(`Your change request for ${data.item} is filled in the ask's chat. Press Enter there to send it to the agent.`);
}

/** Confirm and set a stage of the active ask to done, so the plan matches what the chat shows; the harness still checks its evidence.
 * @param {MissionControl} mc
 * @param {Record<string, string>} data
 * @returns {Promise<void>}
 */
async function markDone(mc, data) {
  const target = mc.target();
  const state = snapshot(target.uri.fsPath, mc.selected);
  const stage = state.reviews.find(row => row.item === data.item);
  if (!state.ask?.active || !stage || !data.item.startsWith('stage:') || stage.ready) {
    throw new Error('Only a planned or active stage of the active ask can be marked done.');
  }
  const flow = await mc.connect();
  const note = await vscode.window.showInputBox({ title: `Mark ${data.item} done: what was delivered?`, ignoreFocusOut: true,
    validateInput: value => !value.trim() ? 'A note is required.' : value.length > 4000 ? 'Use at most 4,000 characters.' : null });
  if (note === undefined) return;
  const confirm = await vscode.window.showWarningMessage(`Mark ${data.item} done?`, { modal: true,
    detail: `${target.uri.fsPath}\n\n“${note}”\n\nThis sets the stage status to done, as the agent does when it finishes; the harness refuses it while the stage's `
      + 'required evidence is missing. You can then accept it.' }, 'Mark done');
  if (confirm !== 'Mark done') return;
  await flow.markStageDone(target.uri.fsPath, data.revision, data.item, note);
  void vscode.window.showInformationMessage(`${data.item} is done; you can accept it now.`);
}

/** Pick a library skill the active ask does not have, confirm, and add it to the ask; agents load it from the next prompt.
 * @param {MissionControl} mc
 * @param {string} ask The ask on screen when the user clicked.
 * @returns {Promise<void>}
 */
async function addSkill(mc, ask) {
  const target = mc.target();
  const state = sameAsk(target.uri.fsPath, ask);
  if (!state.ask) throw new Error('Make this ask active before adding skills to it.');
  const flow = await mc.connect();
  const offered = await flow.availableSkills(target.uri.fsPath);
  if (!offered.length) {
    void vscode.window.showInformationMessage('The ask already has every library skill.');
    return;
  }
  const picked = await vscode.window.showQuickPick(offered.map(skill => ({ label: skill.name, description: `${skill.tokens.toLocaleString('en-US')} tokens · ${skill.status}`,
    detail: skill.description })), { title: `Add a skill to ${state.ask.title}`, placeHolder: 'Search the skill library', matchOnDetail: true, ignoreFocusOut: true });
  if (!picked) return;
  const load = state.skillLoad;
  const tokens = (load ? load.tokens : 0) + (offered.find(skill => skill.name === picked.label)?.tokens || 0);
  const confirm = await vscode.window.showWarningMessage(`Add ${picked.label} to this ask?`, { modal: true,
    detail: `${state.ask.id}\n\nThe skill is installed into ${STATE}/skills/ and listed in the ask's plan. Agents load it from the next message you send; `
      + `the ask's skills then come to ${tokens.toLocaleString('en-US')} tokens${load ? ` against a ${load.maxTokens.toLocaleString('en-US')}-token guideline` : ''}.` }, 'Add skill');
  if (confirm !== 'Add skill') return;
  await flow.addSkill(target.uri.fsPath, ask, picked.label);
  void vscode.window.showInformationMessage(`${picked.label} added; agents load it from your next message.`);
}

/** Open what a feature task's recorded commits changed, base to head, in VS Code's multi-file diff editor.
 * @param {MissionControl} mc
 * @param {string} item
 * @returns {Promise<void>}
 */
async function showChanges(mc, item) {
  const root = mc.target().uri.fsPath;
  const review = snapshot(root, mc.selected).reviews.find(row => row.item === item);
  if (!review?.commit) throw new Error(`${item} has no recorded commits to show.`);
  const { base, head } = review.commit;
  const git = vscode.extensions.getExtension('vscode.git');
  if (!git) throw new Error('VS Code\'s built-in Git extension is disabled; enable it to see what a task changed.');
  const api = (await git.activate()).getAPI(1);
  const run = promisify(execFile);
  const { stdout } = await run('git', ['diff', '--name-status', '-z', '-M', '--relative', base, head, '--'], { cwd: root, windowsHide: true })
    .catch(error => { throw new Error(`git diff ${base.slice(0, 7)}..${head.slice(0, 7)} failed in ${root}: ${error.message}`, { cause: error }); });
  const parts = stdout.split('\0').filter(Boolean);
  /** @type {[unknown, unknown, unknown][]} */
  const rows = [];
  for (let index = 0; index < parts.length;) {
    const status = parts[index];
    const old = parts[index + 1];
    const now = /^[RC]/.test(status) ? parts[index + 2] : old;
    index += /^[RC]/.test(status) ? 3 : 2;
    const file = (/** @type {string} */ relative) => vscode.Uri.file(containedPath(root, relative));
    rows.push([file(now), status.startsWith('A') ? undefined : api.toGitUri(file(old), base), status.startsWith('D') ? undefined : api.toGitUri(file(now), head)]);
  }
  if (!rows.length) throw new Error(`${item}: commits ${base.slice(0, 7)}..${head.slice(0, 7)} change no files in this folder.`);
  await vscode.commands.executeCommand('vscode.changes', `${item}: ${base.slice(0, 7)}..${head.slice(0, 7)}`, rows);
}

/** Run one of the extension's own commands; it asks its own questions.
 * @param {MissionControl} mc
 * @param {string} name
 * @returns {Promise<void>}
 */
async function command(mc, name) {
  if (!Object.hasOwn(BASE_COMMANDS, name)) throw new Error('Unknown harness command.');
  const target = mc.target();
  if (vscode.workspace.workspaceFolders?.[0]?.uri.toString() !== target.uri.toString()) {
    throw new Error('Set-up and pack commands act on the first folder of this window. Open the selected folder in its own window to use them.');
  }
  await vscode.commands.executeCommand(BASE_COMMANDS[/** @type {keyof typeof BASE_COMMANDS} */ (name)]);
  if (name === 'installPack' || name === 'managePacks') await mc.loadPacks();
}

/** Turn research telemetry on (the extension's own warning explains what it records) or off.
 * @param {string} value
 * @returns {Promise<void>}
 */
async function telemetrySwitch(value) {
  if (value !== 'on' && value !== 'off') throw new Error('Telemetry must be on or off.');
  await vscode.commands.executeCommand(value === 'on' ? cmd('researchTelemetry') : cmd('researchTelemetryOff'));
}

/** Return the paths of the files in an ask's folder tree.
 * @param {import('./types').FileNode[]} nodes
 * @returns {string[]}
 */
function treeFiles(nodes) {
  return nodes.flatMap(node => node.kind === 'file' ? [node.path] : treeFiles(node.children));
}

/** Open a file Mission Control lists: in the project tree, the ask's folder, evidence, the plan, files the agent changed, files a question, guard
 * alert or sign-off names, or a loaded skill.
 * @param {MissionControl} mc
 * @param {string} relative
 * @returns {Promise<void>}
 */
async function openFile(mc, relative) {
  const root = mc.target().uri.fsPath;
  const state = snapshot(root, mc.selected);
  const session = mc.state.activity?.session;
  const named = [...(session?.events || []), ...(session?.current ? [session.current] : [])].filter(event => ['ask', 'guard'].includes(event.kind));
  const listed = [...state.files, ...(session?.files.map(file => file.path) || []), ...named.flatMap(event => event.files), ...state.reviews.flatMap(review => review.files),
    ...state.skills.map(skill => path.join(STATE, 'skills', skill.name, 'SKILL.md')), ...(state.ask ? treeFiles(askTree(root, state.ask.id).entries) : []), ...evaluationFiles(root),
    ...treeFiles(projectTree(root).entries)]
    .map(file => path.normalize(file));
  if (!listed.includes(path.normalize(relative))) throw new Error('That file is not listed in Mission Control.');
  const uri = vscode.Uri.file(containedPath(state.workspace, relative));
  if (!fs.statSync(uri.fsPath).isFile()) throw new Error(`Not a file: ${relative}`);
  if (IMAGES.includes(path.extname(relative).toLowerCase())) await vscode.commands.executeCommand('vscode.open', uri);
  else await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: true });
}

module.exports = { selectAsk, activateAsk, selectChat, openChat, linkChat, editPlan, revealAsk, review, markDone, addSkill, showChanges, command, telemetrySwitch, openFile };
