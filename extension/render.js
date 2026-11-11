'use strict';
/** Render the ARIA agent plugin from the packaged templates; no VS Code API, so it can be tested with plain Node. */

const fs = require('fs');
const path = require('path');
const { BRAND } = require('./brand');

const PLACEHOLDER = /\{\{RUNTIME\}\}/g;
// Templates name the default state folder; a brand with another folder gets its own.
const STATE_PATHS = /\.aria\//g;
const PYTHON_CALL = /\bpython "\{\{RUNTIME\}\}/g;
// Hooks run through agent_compat.py, which reads the Local and the Copilot harness payloads and answers in the harness's own format.
const HOOK_CALL = /python "\{\{RUNTIME\}\}\/((?:hooks|scripts)\/[\w.-]+\.py)"((?: [\w-]+)*)'/g;
const COMMAND_SPEC = /^ {6}command: 'python "\{\{RUNTIME\}\}\/((?:hooks|scripts)\/[\w.-]+\.py)"((?: [\w-]+)*)'$/;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
const HOOKS_BLOCK = /^hooks:\r?\n(?:[ \t]+.*\r?\n)*/m;
const BATCH_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const LOCAL_CHECK = '\nHarness check: the session hooks add a line starting `Frontier HVE deliverable templates: session` to your context. '
  + 'If it is missing, the guards are not running: tell the user to start a new chat with Session Target **Local** or **Copilot** before you continue.\n';
const NO_PYTHON = '\n> **Python not found.** ARIA found no Python 3.11+ when it set up this agent, so its guard hooks are off and its '
  + 'harness commands will fail. Before anything else, tell the user to install Python 3.11+, run **ARIA: Set up** and reload the window.\n';

/**
 * Rewrite an agent's frontmatter hooks through agent_compat.py, batching multiple PreToolUse or PostToolUse hooks into one process.
 * @param {string} front Agent YAML frontmatter including fences.
 * @returns {string}
 */
function renderHooks(front) {
  const match = HOOKS_BLOCK.exec(front);
  if (!match) return front;
  const lines = match[0].replace(/\r\n/g, '\n').trimEnd().split('\n');
  /** @type {{event: string, items: {raw: string[], script: string, args: string, env: string[], timeout: number | null}[]}[]} */
  const sections = [];
  for (const line of lines.slice(1)) {
    const ev = /^  (\w+):$/.exec(line);
    if (ev) sections.push({ event: ev[1], items: [] });
    else if (line === '    - type: command') sections.at(-1).items.push({ raw: [line], script: '', args: '', env: [], timeout: null });
    else {
      const item = sections.at(-1).items.at(-1);
      item.raw.push(line);
      const cmd = COMMAND_SPEC.exec(line);
      const timeout = /^ {6}timeout: (\d+)$/.exec(line);
      const envVar = /^ {8}(\w+): (\S+)$/.exec(line);
      if (cmd) { item.script = cmd[1]; item.args = cmd[2].trim(); }
      else if (timeout) item.timeout = Number(timeout[1]);
      else if (envVar) item.env.push(`${envVar[1]}=${envVar[2]}`);
    }
  }
  const rendered = ['hooks:'];
  for (const { event, items } of sections) {
    rendered.push(`  ${event}:`);
    if (BATCH_EVENTS.has(event) && items.length > 1) {
      const specs = items.map((i) => [i.script, ...i.env, ...(i.args ? ['--', ...i.args.split(/\s+/)] : [])].join(' ')).join(' + ');
      const maxTimeout = Math.max(0, ...items.map((i) => i.timeout || 0));
      rendered.push('    - type: command', `      command: 'python "{{RUNTIME}}/hooks/agent_compat.py" vscode ${specs}'`);
      if (maxTimeout > 0) rendered.push(`      timeout: ${maxTimeout}`);
    } else {
      for (const item of items) {
        rendered.push(...item.raw.map((row) => row.replace(HOOK_CALL, (_, s, a) => `python "{{RUNTIME}}/hooks/agent_compat.py" vscode ${s}${a ? ` --${a}` : ''}'`)));
      }
    }
  }
  return front.replace(HOOKS_BLOCK, `${rendered.join('\n')}\n`);
}

/**
 * Return one agent rendered for this machine: runtime path and Python launcher filled in, or, without Python, no hooks and a warning.
 * @param {string} text Agent template.
 * @param {string} runtime Runtime folder with forward slashes.
 * @param {string | null} python Python launcher command (for example `python3` or `py -3`), or null when none was found.
 * @returns {string}
 */
function renderAgent(text, runtime, python) {
  text = text.replace(STATE_PATHS, `${BRAND.state_dir}/`);
  if (!text.includes('python "{{RUNTIME}}')) {
    return text.replace(PLACEHOLDER, runtime);
  }
  const front = FRONTMATTER.exec(text)[0];
  const body = text.slice(front.length);
  if (python === null) {
    return (front.replace(HOOKS_BLOCK, '').replace(/^description: /m, 'description: (Needs Python) ') + NO_PYTHON + body)
      .replace(PLACEHOLDER, runtime);
  }
  const launcher = python === 'python' ? '' : `\nPython on this machine is \`${python}\`: use it wherever a skill or tool says \`python\`.\n`;
  const hooked = renderHooks(front);
  return (hooked + (front.includes('SessionStart:') ? LOCAL_CHECK : '') + launcher + body)
    .replace(PYTHON_CALL, `${python} "{{RUNTIME}}`).replace(PLACEHOLDER, runtime);
}

/**
 * Delete the entries of dir that are not in keep.
 * @param {string} dir
 * @param {string[]} keep
 */
function removeStale(dir, keep) {
  for (const name of fs.readdirSync(dir).filter((entry) => !keep.includes(entry))) {
    fs.rmSync(path.join(dir, name), { recursive: true });
  }
}

/**
 * Write the plugin folder in place (VS Code holds it open): plugin.json, skills, guardrail scripts, and agents with the runtime path.
 * @param {string} extensionDir Folder of the installed extension (holds agents/, skills/ and runtime/).
 * @param {string} pluginDir Folder to create or update for the rendered plugin.
 * @param {string} version Extension version recorded in plugin.json.
 * @param {string | null} python Python launcher command, or null when none was found.
 * @returns {string[]} Names of the rendered agent files.
 */
function renderPlugin(extensionDir, pluginDir, version, python) {
  const runtime = path.join(extensionDir, 'runtime').split(path.sep).join('/');
  const agentsOut = path.join(pluginDir, 'com.github.copilot', 'agents');
  fs.mkdirSync(agentsOut, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: BRAND.prefix,
    version,
    description: `${BRAND.product} agents and skills, rendered by the ${BRAND.product} extension.`,
  }, null, 2) + '\n');
  for (const part of ['skills', 'scripts']) {
    const source = part === 'skills' ? path.join(extensionDir, 'skills') : path.join(extensionDir, 'runtime', 'scripts');
    fs.cpSync(source, path.join(pluginDir, part), { recursive: true });
    removeStale(path.join(pluginDir, part), fs.readdirSync(source));
  }
  for (const entry of BRAND.state_dir === '.aria' ? [] : fs.readdirSync(path.join(pluginDir, 'skills'), { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (entry.isFile() && entry.name.endsWith('.md')) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(STATE_PATHS, `${BRAND.state_dir}/`));
  }
  const agents = fs.readdirSync(path.join(extensionDir, 'agents')).filter((name) => name.endsWith('.agent.md'));
  for (const name of agents) {
    const text = fs.readFileSync(path.join(extensionDir, 'agents', name), 'utf8');
    fs.writeFileSync(path.join(agentsOut, name), renderAgent(text, runtime, python));
  }
  removeStale(agentsOut, agents);
  return agents;
}

/**
 * Return the core hook block for a pack agent: template guard and the skill loader.
 * @returns {string}
 */
function packHooks() {
  const command = (script) => `    - type: command\n      command: 'python "{{RUNTIME}}/hooks/${script}"'\n`;
  const loader = `${command('skill_loader.py')}      env:\n        HARNESS_SKILLS_MIN_STATUS: provisional\n`;
  return `hooks:\n  SessionStart:\n${command('template_guard.py')}`
    + `  UserPromptSubmit:\n${command('template_guard.py')}${loader}`
    + `  PreToolUse:\n${loader}  PostToolUse:\n${loader}`
    + `  Stop:\n${command('template_guard.py')}`;
}

/**
 * Render each available expertise pack into <renderedRoot>/<id>/ as an Agent Plugins folder (agents named '<pack>:<agent>' with core
 * hooks) and delete rendered folders of packs no longer available; return the rendered folders.
 * @param {string} extensionDir Folder of the installed extension (holds runtime/).
 * @param {string | null} python Python launcher command, or null when none was found.
 * @param {string} renderedRoot Folder that holds one rendered folder per pack.
 * @param {{id: string, name: string, version: string, folder: string, manifest: object}[]} packs Packs from `plugin.py packs`.
 * @returns {string[]}
 */
function renderPacks(extensionDir, python, renderedRoot, packs) {
  const runtime = path.join(extensionDir, 'runtime').split(path.sep).join('/');
  fs.mkdirSync(renderedRoot, { recursive: true });
  const folders = [];
  for (const pack of packs) {
    const out = path.join(renderedRoot, pack.id);
    const agentsOut = path.join(out, 'com.github.copilot', 'agents');
    fs.mkdirSync(agentsOut, { recursive: true });
    fs.writeFileSync(path.join(out, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: pack.name,
      version: pack.version,
      description: `${pack.manifest.displayName} (ARIA expertise pack by ${pack.manifest.publisher}), rendered by ARIA.`,
    }, null, 2) + '\n');
    const files = [];
    for (const agent of pack.manifest.agents) {
      const source = fs.readFileSync(path.join(pack.folder, agent.file), 'utf8').replace(/\r\n/g, '\n');
      const front = FRONTMATTER.exec(source)[0];
      const named = front.replace(/^name: .*$/m, `name: ${pack.name}:${agent.name}`).replace(/\n---\n$/, `\n${packHooks()}---\n`);
      const file = `${agent.name}.agent.md`;
      fs.writeFileSync(path.join(agentsOut, file), renderAgent(named + source.slice(front.length), runtime, python));
      files.push(file);
    }
    removeStale(agentsOut, files);
    folders.push(out);
  }
  removeStale(renderedRoot, packs.map((pack) => pack.id));
  return folders;
}

module.exports = { renderPlugin, renderPacks };
