'use strict';
/** Mission Control's user actions on asks, chats, sign-offs, files and harness commands; each change to the workspace is confirmed first. */
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { BASE_COMMANDS } = require('./lifecycle-cli');
const { snapshot } = require('./workspace-state');
const { current } = require('./workflow');
const { listAsks, askTree, evaluationFiles } = require('./asks');
const { claimsFrom } = require('./chats');
const { containedPath } = require('./file-access');
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
  mc.chat = chat;
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
  await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(containedPath(state.workspace, path.join('.aria', 'asks', state.ask.id))));
}

/** Confirm and record a human sign-off through the guarded review commands.
 * @param {MissionControl} mc
 * @param {Record<string, string>} data
 * @returns {Promise<void>}
 */
async function review(mc, data) {
  if (data.value !== 'accepted' && data.value !== 'changes') throw new Error('Unknown review decision.');
  const target = mc.target();
  const flow = await mc.connect();
  const ticket = await flow.prepareReview(target.uri.fsPath, data.revision, data.item, data.value);
  const note = await vscode.window.showInputBox({ title: data.value === 'accepted' ? `Accept ${data.item}: what did you check?` : `Changes for ${data.item}: what needs to change?`,
    ignoreFocusOut: true, validateInput: value => !value.trim() ? 'A note is required.' : value.length > 4000 ? 'Use at most 4,000 characters.' : null });
  if (note === undefined) return;
  const label = data.value === 'accepted' ? 'Accept' : 'Request changes';
  const confirm = await vscode.window.showWarningMessage(`${label}: ${data.item}?`, { modal: true,
    detail: `Ask ${ticket.ask} in ${target.uri.fsPath}\n\n“${note}”\n\nThis records your decision in the ask. It does not push code or start the next stage.` }, label);
  if (confirm !== label) return;
  mc.target();
  await flow.recordReview(target.uri.fsPath, ticket, note);
  void vscode.window.showInformationMessage(`${label === 'Accept' ? 'Accepted' : 'Changes requested for'} ${data.item}.`);
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
 * @param {string} revision
 * @returns {Promise<void>}
 */
async function addSkill(mc, revision) {
  const target = mc.target();
  const state = current(target.uri.fsPath, revision);
  if (!state.ask?.active) throw new Error('Make this ask active before adding skills to it.');
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
    detail: `${state.ask.id}\n\nThe skill is installed into .aria/skills/ and listed in the ask's plan. Agents load it from the next message you send; `
      + `the ask's skills then come to ${tokens.toLocaleString('en-US')} tokens${load ? ` against a ${load.maxTokens.toLocaleString('en-US')}-token guideline` : ''}.` }, 'Add skill');
  if (confirm !== 'Add skill') return;
  await flow.addSkill(target.uri.fsPath, revision, picked.label);
  void vscode.window.showInformationMessage(`${picked.label} added; agents load it from your next message.`);
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
  await vscode.commands.executeCommand(value === 'on' ? 'frontierHve.researchTelemetry' : 'frontierHve.researchTelemetryOff');
}

/** Return the paths of the files in an ask's folder tree.
 * @param {import('./types').FileNode[]} nodes
 * @returns {string[]}
 */
function treeFiles(nodes) {
  return nodes.flatMap(node => node.kind === 'file' ? [node.path] : treeFiles(node.children));
}

/** Open a file Mission Control lists: in the ask's folder, evidence, the plan, files the agent changed, files a question, guard alert or
 * sign-off names, or a loaded skill.
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
    ...state.skills.map(skill => path.join('.aria', 'skills', skill.name, 'SKILL.md')), ...(state.ask ? treeFiles(askTree(root, state.ask.id).entries) : []), ...evaluationFiles(root)]
    .map(file => path.normalize(file));
  if (!listed.includes(path.normalize(relative))) throw new Error('That file is not listed in Mission Control.');
  const uri = vscode.Uri.file(containedPath(state.workspace, relative));
  if (!fs.statSync(uri.fsPath).isFile()) throw new Error(`Not a file: ${relative}`);
  if (IMAGES.includes(path.extname(relative).toLowerCase())) await vscode.commands.executeCommand('vscode.open', uri);
  else await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: true });
}

module.exports = { selectAsk, activateAsk, selectChat, linkChat, editPlan, revealAsk, review, markDone, addSkill, command, telemetrySwitch, openFile };
