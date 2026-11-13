'use strict';
/** Perform explicit ask and human-review actions through the existing harness. */
const fs = require('node:fs');
const path = require('node:path');
const { lifecycle } = require('./lifecycle-cli');
const { snapshot, askId } = require('./workspace-state');
const { Reader } = require('./file-access');
const { record, text, list, integer } = require('./validate');
const { BRAND } = require('../brand');
const STATE = BRAND.state_dir;

/** @typedef {{ask: string, item: string, itemRevision: string, value: 'accepted' | 'changes'}} ReviewTicket */

/** Return the workspace with the review item as the user saw it; the agent's other writes (evidence, attempts, loop state) do not matter.
 * @param {string} workspace
 * @param {string} item
 * @param {string} revision The item's revision when the user acted on it.
 * @returns {{state: import('./types').Snapshot, review: import('./types').Review}}
 */
function itemAsSeen(workspace, item, revision) {
  const state = snapshot(workspace);
  const review = state.reviews.find(row => row.item === item);
  if (!review || review.revision !== revision) {
    throw new Error(`${item} changed since you acted on it (its ask, status, sign-off or the plan moved on). Look at it again and retry.`);
  }
  return { state, review };
}

/** Return the workspace while the active ask is still the one the user saw.
 * @param {string} workspace
 * @param {string | null} ask
 * @returns {import('./types').Snapshot}
 */
function sameAsk(workspace, ask) {
  const state = snapshot(workspace);
  if ((state.ask?.active ? state.ask.id : null) !== ask) throw new Error('The active ask changed in the meantime. Look at Mission Control again and retry.');
  return state;
}

/** Coordinate user-confirmed mutations without running agents or feature checks. */
class Workflow {
  /** @param {import('./lifecycle-cli').Runtime} connection @param {string} storage */
  constructor(connection, storage) {
    this.connection = connection;
    this.storage = storage;
    this.busy = false;
  }

  /** Create a private request input and remove it after the CLI finishes.
   * @param {string} request
   * @param {(file: string) => Promise<unknown>} action
   * @returns {Promise<unknown>}
   */
  async requestFile(request, action) {
    text(request, 'Ask request');
    if (request.length > 20000) throw new Error('Ask request must be at most 20,000 characters.');
    fs.mkdirSync(this.storage, { recursive: true });
    const folder = fs.mkdtempSync(path.join(this.storage, 'request-'));
    const file = path.join(folder, 'request.txt');
    try {
      fs.writeFileSync(file, request, 'utf8');
      return await action(file);
    } finally {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      fs.rmdirSync(folder);
    }
  }

  /** Describe where a request lands, using the harness's own recommendation, without creating anything.
   * @param {string} workspace
   * @param {string} request
   * @returns {Promise<{activeAsk: string | null, verdict: string, why: string}>}
   */
  async describeAsk(workspace, request) {
    const state = snapshot(workspace);
    const activeAsk = state.ask?.active ? state.ask.id : null;
    const result = record(await this.requestFile(request, file => lifecycle(this.connection, workspace, ['where', file])), 'Ask scope');
    sameAsk(workspace, activeAsk);
    return { activeAsk, verdict: text(result.verdict, 'Scope verdict'), why: text(result.why, 'Scope reason') };
  }

  /** Serialize UI-owned mutations and release the lock on failure.
   * @param {() => Promise<import('./types').Snapshot>} action
   * @returns {Promise<import('./types').Snapshot>}
   */
  async mutate(action) {
    if (this.busy) throw new Error('Another UI operation is still running.');
    this.busy = true;
    try { return await action(); } finally { this.busy = false; }
  }

  /** Create and verify a real ask after the user confirms its target workspace, while the active ask is still the one they saw.
   * @param {string} workspace
   * @param {string | null} activeAsk
   * @param {string} slug
   * @param {string} request
   * @returns {Promise<import('./types').Snapshot>}
   */
  async createAsk(workspace, activeAsk, slug, request) {
    return this.mutate(async () => {
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(slug)) throw new Error('Ask name must contain 1-41 lowercase letters, digits or hyphens.');
      sameAsk(workspace, activeAsk);
      const result = record(await this.requestFile(request, file =>
        lifecycle(this.connection, workspace, ['contract', 'direct', slug, `${BRAND.product} Lite`, file])), 'Created ask');
      const created = askId(result.ask);
      const state = snapshot(workspace);
      if (state.ask?.id !== created) throw new Error(`Ask ${created} was created, but the active ask changed before verification. Inspect the project before continuing.`);
      return state;
    });
  }

  /** Remove an ask whose files were deleted from the project record through the harness.
   * @param {string} workspace
   * @param {string} ask
   * @returns {Promise<void>}
   */
  async forgetAsk(workspace, ask) {
    await this.mutate(async () => {
      const result = record(await lifecycle(this.connection, workspace, ['forget', askId(ask)]), 'Forgotten ask');
      if (result.forgotten !== ask) throw new Error(`The harness did not forget ${ask}.`);
      return snapshot(workspace);
    });
  }

  /** Make an existing ask the active one through the harness and verify the pointer.
   * @param {string} workspace
   * @param {string} ask
   * @returns {Promise<import('./types').Snapshot>}
   */
  async openAsk(workspace, ask) {
    return this.mutate(async () => {
      const result = record(await lifecycle(this.connection, workspace, ['open', askId(ask)]), 'Opened ask');
      const state = snapshot(workspace);
      if (result.active !== ask || state.ask?.id !== ask) throw new Error(`The harness did not make ${ask} the active ask.`);
      return state;
    });
  }

  /** Check a review the user started against the item as they saw it.
   * @param {string} workspace
   * @param {string} revision The item's revision on screen.
   * @param {string} item
   * @param {'accepted' | 'changes'} value
   * @returns {ReviewTicket}
   */
  prepareReview(workspace, revision, item, value) {
    const { state, review } = itemAsSeen(workspace, item, revision);
    if (!state.ask?.active) throw new Error('Make this ask active to sign off.');
    if (state.pendingPlanTicks) throw new Error('Plan checkboxes changed. Reconcile them through the harness before another review.');
    if (!['accepted', 'changes'].includes(value)) throw new Error('Unknown human review decision.');
    if (value === 'accepted' && (!review.ready || state.planState === 'unsynced')) {
      throw new Error('Acceptance requires completed work, its required evidence, and no unreconciled plan edits.');
    }
    return { ask: state.ask.id, item, itemRevision: revision, value };
  }

  /** Persist a confirmed review through the guarded core API, with a ticket taken just before recording, and verify its saved record;
   * changes requested on a done stage set it back to active, so it is not shown as ready until the agent finishes them.
   * @param {string} workspace
   * @param {ReviewTicket} ticket
   * @param {string} note
   * @returns {Promise<import('./types').Snapshot>}
   */
  async recordReview(workspace, ticket, note) {
    return this.mutate(async () => {
      text(note, 'Human review note');
      const { state, review } = itemAsSeen(workspace, ticket.item, ticket.itemRevision);
      if (state.ask?.id !== ticket.ask || !state.ask.active) throw new Error('The active ask changed in the meantime. Look at Mission Control again and retry.');
      const core = record(await lifecycle(this.connection, workspace, ['review-status', ticket.ask]), 'Review ticket');
      const coreRevision = text(core.revision, 'Review revision');
      if (core.ask !== ticket.ask || !/^[a-f0-9]{64}$/.test(coreRevision)) throw new Error('Harness returned an invalid review ticket.');
      const result = record(await lifecycle(this.connection, workspace,
        ['tick-for', ticket.ask, coreRevision, ticket.item, ticket.value, note]), 'Recorded review');
      if (result.ask !== ticket.ask || result.item !== ticket.item || result.value !== ticket.value) throw new Error('Harness returned a different review result.');
      const reader = new Reader(workspace);
      const saved = record(reader.json(path.join(STATE, 'asks', ticket.ask, 'contract.json')), 'Saved contract');
      const entry = record(record(saved.checklist, 'Saved checklist')[ticket.item], 'Saved review');
      if (entry.value !== ticket.value || entry.note !== note) throw new Error('Review response did not match the saved human decision.');
      if (ticket.value === 'changes' && ticket.item.startsWith('stage:') && review.status === 'done') {
        const stage = ticket.item.slice('stage:'.length);
        const reopened = record(await lifecycle(this.connection, workspace, ['stage', stage, 'active', `Changes requested: ${note}`]), 'Stage update');
        if (reopened.name !== stage || reopened.status !== 'active') throw new Error('Harness returned a different stage update.');
      }
      return snapshot(workspace);
    });
  }

  /** Set a planned or active stage of the active ask to done for the user, while the stage is as they saw it.
   * @param {string} workspace
   * @param {string} revision The stage's revision on screen.
   * @param {string} item
   * @param {string} note
   * @returns {Promise<import('./types').Snapshot>}
   */
  async markStageDone(workspace, revision, item, note) {
    return this.mutate(async () => {
      text(note, 'Stage note');
      const { state, review } = itemAsSeen(workspace, item, revision);
      if (!state.ask?.active) throw new Error('Make this ask active before changing its stages.');
      if (!item.startsWith('stage:') || review.ready) throw new Error('Only a planned or active stage of the active ask can be marked done.');
      const stage = item.slice('stage:'.length);
      const result = record(await lifecycle(this.connection, workspace, ['stage', stage, 'done', note]), 'Stage update');
      if (result.name !== stage || result.status !== 'done') throw new Error('Harness returned a different stage update.');
      return snapshot(workspace);
    });
  }

  /** Return the library skills the active ask does not have yet.
   * @param {string} workspace
   * @returns {Promise<{name: string, description: string, status: string, tokens: number}[]>}
   */
  async availableSkills(workspace) {
    return list(await lifecycle(this.connection, workspace, ['skills', 'available']), 'Available skills').map(value => {
      const row = record(value, 'Available skill');
      return { name: text(row.name, 'Skill name'), description: text(row.description, 'Skill description', true), status: text(row.status, 'Skill status'),
        tokens: integer(row.skill_tokens, 'Skill tokens') };
    });
  }

  /** Add a library skill to the ask the user saw, while it is still active, and verify the contract lists it.
   * @param {string} workspace
   * @param {string} ask
   * @param {string} name
   * @returns {Promise<import('./types').Snapshot>}
   */
  async addSkill(workspace, ask, name) {
    return this.mutate(async () => {
      sameAsk(workspace, ask);
      const result = record(await lifecycle(this.connection, workspace, ['skills', 'add', name]), 'Added skill');
      const after = snapshot(workspace);
      if (result.added !== name || !after.skills.some(skill => skill.name === name)) throw new Error(`The harness did not add ${name} to the ask.`);
      return after;
    });
  }
}

module.exports = { Workflow, sameAsk };
