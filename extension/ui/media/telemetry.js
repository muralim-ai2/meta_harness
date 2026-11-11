'use strict';
/** Mission Control's Telemetry page: one chat's numbers, what fills its context window, and an experimental model review with standard questions. */
(function (root) {
  const modular = typeof module === 'object' && module.exports;
  /** @type {typeof globalThis.hveVnode} */
  const { h } = modular ? require('./vnode') : root.hveVnode;
  /** @type {typeof globalThis.hveMarkdown} */
  const markdown = modular ? require('./markdown') : root.hveMarkdown;
  /** @type {typeof globalThis.hveViews} */
  const { icon, ago, count, plural, button, telemetrySwitch } = modular ? require('./views') : root.hveViews;
  const QUESTIONS = [
    'Did the agent start sub-agents to explore different paths as part of its reasoning, and did it use what they found?',
    'Where did it repeat tool calls or loop without making progress?',
    'Where did it get stuck, and what got it moving again?',
    'What did it decide without asking me?',
    'Which errors or failed checks did it ignore or work around?',
    'What filled its context window most, and was all of it needed?',
    'Did it follow the plan and the skills it loaded, or drift from them?',
  ];
  /** @type {Record<string, [string, string, string]>} */
  const GROUPS = { reads: ['Files read', 'eye', 'blue'], skills: ['Skills loaded', 'box', 'teal'], images: ['Images viewed', 'eye', 'pink'],
    edits: ['Edits and new files', 'pencil', 'amber'], commands: ['Commands', 'terminal', 'violet'], searches: ['Searches', 'search', 'indigo'],
    subagents: ['Sub-agents', 'users', 'pink'], web: ['Web pages', 'map', 'blue'], questions: ['Questions to you', 'question', 'amber'],
    messages: ['Your messages and its replies', 'chat', 'violet'], thinking: ['Thinking', 'spark', 'indigo'], other: ['Other tools', 'tool', 'teal'] };
  /** @type {Record<string, string>} */
  const HINT = { reads: 'sized from the files', skills: 'sized from SKILL.md', images: 'about 1,500 tokens each', commands: 'command only; output is not recorded',
    searches: 'query only; results are not recorded', subagents: 'the brief only; their reports are not recorded', web: 'address only',
    thinking: 'reported by research telemetry' };

  /** @typedef {import('../types').Model} Model */
  /** @typedef {import('../types').UiState} UiState */
  /** @typedef {import('../types').VNode} VNode */
  /** @typedef {import('../types').Child} Child */

  /** Return one big-number tile; with a destination it is a button to that page (and Live filter).
   * @param {string} glyph
   * @param {string} label
   * @param {Child} value
   * @param {string} hint
   * @param {string} tone
   * @param {{page: string, filter?: string}} [to]
   * @returns {VNode}
   */
  function tile(glyph, label, value, hint, tone, to) {
    const body = [h('span', { class: 'tele-tile-icon' }, icon(glyph)), h('span', { class: 'tele-value' }, value),
      h('span', { class: 'tele-label' }, label), hint ? h('span', { class: 'tele-hint' }, hint) : null];
    return to ? h('button', { class: `tele-tile tone-${tone}`, type: 'button', 'data-action': 'go', 'data-page': to.page, 'data-filter': to.filter,
      title: `Show on ${to.page === 'skills' ? 'Skills & packs' : 'Live'}` }, ...body) : h('div', { class: `tele-tile tone-${tone}` }, ...body);
  }

  /** Return the chat picker, grouped by the ask each chat works on.
   * @param {Model} model
   * @returns {VNode | null}
   */
  function chatPicker(model) {
    const chats = model.activity?.chats || [];
    if (!chats.length) return null;
    const titles = Object.fromEntries((model.asks || []).map(ask => [ask.id, ask.title]));
    /** @param {import('../types').Chat} chat @returns {string} */
    const label = chat => `${chat.asks[0] ? titles[chat.asks[0].ask] || chat.asks[0].ask : 'No ask'} › ${chat.title || 'Untitled chat'}`;
    const shown = model.activity?.session?.id;
    return h('label', { class: 'tele-field tele-chat' }, h('span', { class: 'section-label' }, `Chat · ${plural(chats.length, 'chat')} in this window`),
      h('select', { 'data-action': 'selectChat', 'data-key': 'chat', disabled: model.busy },
        ...chats.slice().sort((a, b) => label(a).localeCompare(label(b))).map(chat => h('option', { value: chat.id, selected: chat.id === shown }, label(chat)))));
  }

  /** Return the sub-agents breakdown table when the chat delegated work to sub-agents.
   * @param {import('../types').Insights} data
   * @returns {VNode | null}
   */
  function subagentsTable(data) {
    if (!data.subagents.length) return null;
    const subTurns = data.subagents.reduce((sum, row) => sum + row.turns, 0);
    const subReads = data.subagents.reduce((sum, row) => sum + row.reads, 0);
    const subSkills = data.subagents.reduce((sum, row) => sum + row.skills, 0);
    return h('section', { class: 'card tele-subagents' },
      h('header', { class: 'card-head' },
        h('h2', null, icon('users'), ` Sub-agents · ${plural(data.subagents.length, 'run')}`),
        h('span', { class: 'muted' }, `Main agent: ${plural(data.main.turns, 'turn')}, ${plural(data.main.reads, 'read')} (${data.main.skillReads} skill) · `
          + `Sub-agents isolated ${plural(subTurns, 'turn')} and ${plural(subReads, 'read')} (${subSkills} skill) outside the main window`)),
      h('div', { class: 'tele-table-wrap' },
        h('table', { class: 'tele-table' },
          h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Sub-agent & task'), h('th', null, 'Model'),
            h('th', null, 'Activity'), h('th', null, 'Reads / skills'), h('th', null, 'Non-cached / total'), h('th', null, 'AIU'), h('th', null, 'State'))),
          h('tbody', null, ...data.subagents.map((row, index) => h('tr', null,
            h('td', { class: 'muted' }, String(index + 1)),
            h('td', null, h('strong', null, row.name), row.task ? h('div', { class: 'muted' }, row.task) : null),
            h('td', { class: 'muted' }, row.model || '—'),
            h('td', null, `${plural(row.turns, 'turn')} · ${plural(row.tools, 'tool')}`),
            h('td', null, `${plural(row.reads, 'read')} · ${row.skills} skill`),
            h('td', { class: 'num' }, row.measured && row.nonCached !== null && row.total !== null
              ? `${count(row.nonCached)} / ${count(row.total)}` : h('span', { class: 'muted' }, 'isolated window')),
            h('td', { class: 'num' }, row.measured && row.aiu !== null ? row.aiu.toFixed(2) : '—'),
            h('td', null, h('span', { class: `tele-pill ${row.state === 'ok' ? 'measured' : 'estimated'}` }, row.state))))))));
  }

  /** Return what fills the chat's main-agent context window, largest first, each with a bar against the largest.
   * @param {import('../types').Insights} data
   * @returns {VNode}
   */
  function context(data) {
    const top = Math.max(1, ...data.context.map(row => row.tokens));
    const subReads = data.subagents.reduce((sum, row) => sum + row.reads, 0);
    const subtitle = data.subagents.length
      ? `main agent window (${plural(subReads, 'read')} offloaded to ${plural(data.subagents.length, 'sub-agent')}) · estimated from this chat's calls and files`
      : 'estimated from this chat\'s calls and files';
    return h('section', { class: 'card' }, h('header', { class: 'card-head' }, h('h2', null, 'What fills the context window'),
      h('span', { class: 'muted' }, subtitle)),
    h('ul', { class: 'tele-context' }, ...data.context.map(row => {
      const [label, glyph, tone] = GROUPS[row.group] || GROUPS.other;
      return h('li', { class: `tone-${tone}` }, h('span', { class: 'tele-tile-icon' }, icon(glyph)),
        h('div', { class: 'tele-context-text' }, h('strong', null, label, row.count ? h('span', { class: 'muted' }, ` · ${plural(row.count, 'call')}`) : null),
          h('span', { class: 'muted' }, [row.items.join(' · '), HINT[row.group]].filter(Boolean).join(' — '))),
        h('span', { class: 'tele-context-bar' }, h('span', { 'style-width': Math.max(3, Math.round(row.tokens / top * 100)) })),
        h('strong', { class: 'num' }, `${count(row.tokens)} tokens`));
    })));
  }

  /** Return the experimental review: model, a standard or own question, Analyze, and the streamed answer.
   * @param {Model} model
   * @param {UiState} ui
   * @param {number} now
   * @returns {VNode}
   */
  function review(model, ui, now) {
    const models = model.models || [];
    const chosen = models.find(row => row.id === ui.model) || models.find(row => /haiku/i.test(row.family + row.name)) || models[0];
    const preset = ui.preset ?? '0';
    const result = model.analysis?.topic === 'chat' ? model.analysis : null;
    return h('section', { class: 'card tele-lab' }, h('header', { class: 'card-head' }, h('h2', null, icon('spark'), ' Ask a model about this chat'),
      h('span', { class: 'tele-badge' }, 'Experimental')),
    h('p', { class: 'muted' }, 'A Copilot model reads this chat\'s activity log (works with research telemetry off) and answers in three crisp bullets that cite step numbers. '
      + 'It uses your Copilot quota; VS Code chooses its reasoning effort.'),
    model.modelsError ? h('div', { class: 'notice error' }, model.modelsError) : null,
    model.models === null && !model.modelsError ? h('p', { class: 'muted' }, 'Loading Copilot models…') : null,
    models.length ? h('div', { class: 'tele-ask' },
      h('label', { class: 'tele-field' }, h('span', { class: 'section-label' }, 'Model'),
        h('select', { 'data-field': 'model', disabled: result?.status === 'running' }, ...models.map(row => h('option', { value: row.id, selected: row.id === chosen?.id }, row.name)))),
      h('label', { class: 'tele-field grow' }, h('span', { class: 'section-label' }, 'Question'),
        h('select', { 'data-field': 'preset' }, ...QUESTIONS.map((question, index) => h('option', { value: String(index), selected: preset === String(index) }, question)),
          h('option', { value: 'custom', selected: preset === 'custom' }, 'My own question…'))),
      button('Analyze', 'analyze', { kind: 'primary', icon: 'spark', disabled: model.busy || result?.status === 'running' || !model.activity?.session,
        title: 'Send this chat\'s activity log and the question to the chosen model' })) : null,
    models.length && preset === 'custom' ? h('textarea', { 'data-field': 'question', rows: 2, maxlength: 1000, placeholder: 'Ask anything about how the agent worked in this chat' },
      ui.question || '') : null,
    result ? h('div', { class: `tele-answer status-${result.status}`, 'aria-live': 'polite' },
      h('div', { class: 'meta' }, `${result.model} · “${result.question}” · ${result.status === 'running' ? 'thinking…' : ago(result.at, now)}`),
      result.text ? h('div', { class: 'markdown' }, ...markdown.render(result.text)) : h('div', { class: 'tele-shimmer' }, h('span', null), h('span', null), h('span', null))) : null);
  }

  /** Render the Telemetry page.
   * @param {Model} model
   * @param {UiState} ui
   * @param {number} now
   * @returns {Child[]}
   */
  function telemetry(model, ui, now) {
    const data = model.insights;
    if (!data) {
      return [h('div', { class: 'empty-state' }, h('strong', null, 'No chat of this ask yet'),
        h('p', { class: 'muted' }, 'Pick any chat of this window to measure it, or start one for this ask.'), chatPicker(model))];
    }
    return [
      h('section', { class: 'tele-hero' }, h('div', { class: 'tele-hero-text' }, h('span', { class: 'section-label' }, 'Telemetry · one chat'),
        h('h2', null, data.chat),
        h('div', { class: 'tele-chips' }, h('span', { class: 'tele-chip' }, icon('user'), data.agent || 'agent not recorded'),
          h('span', { class: 'tele-chip' }, icon('terminal'), data.mode ? `${data.mode} session` : 'execution mode not recorded'),
          h('span', { class: 'tele-chip' }, icon('spark'), data.model || 'model not recorded')),
        chatPicker(model)),
      data.measured ? h('div', { class: 'tele-total' },
        h('span', { class: 'tele-big' }, count(data.main.nonCached ?? Math.max(0, data.input - (data.cachedTokens || 0)))),
        h('span', null, 'main non-cached input tokens (context-rot focus)'),
        data.main.peakInput ? h('span', { class: 'muted' }, `Main peak prompt: ${count(data.main.peakInput)} · Main AIU: ${(data.main.aiu ?? data.aiu).toFixed(2)}`) : null,
        h('span', { class: 'tele-aiu' }, `Session: ${count(data.total)} tokens in total · ${data.aiu.toFixed(1)} AI units`))
        : h('div', { class: 'tele-total off' }, h('span', { class: 'muted' }, 'Total tokens and AI units appear for chats recorded with research telemetry on.'), telemetrySwitch(model))),
      h('div', { class: 'tele-tiles' },
        tile('pulse', 'Turns', data.subagents.length ? data.main.turns : data.turns,
          data.subagents.length ? `main agent · +${data.turns - data.main.turns} in ${plural(data.subagents.length, 'sub-agent')}` : 'model calls the agent made',
          'violet', { page: 'live', filter: 'conversation' }),
        tile('tool', 'Tool calls', data.subagents.length ? data.main.toolCalls : data.toolCalls,
          `${plural(data.commands, 'command')} · ${data.failures} failed${data.subagents.length ? ` · +${data.toolCalls - data.main.toolCalls} in sub-agents` : ''}`, 'blue',
          { page: 'live', filter: data.failures ? 'problems' : 'all' }),
        tile('box', 'Skills used', data.skills.count, [data.skills.names.slice(0, 4).join(', ') || 'none read in this chat',
          data.skills.allowed === null ? '' : `${data.skills.allowed} allowed`].filter(Boolean).join(' · '), 'teal', { page: 'skills' }),
        tile('list', 'Skill tokens', count(data.skills.tokens), 'the SKILL.md files this chat read (estimated)', 'amber', { page: 'skills' }),
        tile('chat', 'Prompt and chat tokens', count(data.chatTokens), 'your messages and the main agent\'s replies (estimated)', 'pink', { page: 'live', filter: 'conversation' }),
        tile('spark', 'Thinking tokens', data.thinkingTokens === null ? '—' : count(data.thinkingTokens),
          data.thinkingTokens === null ? 'recorded only with research telemetry on' : 'reasoning the model reported', 'indigo'),
        tile('refresh', 'Cache tokens', (data.main.cachePercent ?? data.cachePercent) === null ? '—' : `${data.main.cachePercent ?? data.cachePercent}%`,
          (data.main.cachePercent ?? data.cachePercent) === null ? 'recorded only with research telemetry on'
            : `Main: ${count(data.main.cached ?? data.cachedTokens ?? 0)} of ${count(data.main.input ?? data.input)} input tokens cached`, 'good')),
      subagentsTable(data),
      review(model, ui, now),
      context(data),
    ];
  }

  const api = { telemetry, QUESTIONS };
  if (modular) module.exports = api;
  else root.hveTelemetry = api;
})(globalThis);
